const express = require('express');
const { body, validationResult } = require('express-validator');
const EC2Instance = require('../models/EC2Instance');
const AWSService = require('../services/awsService');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

// Helper function to get AWS service instance
const getAWSService = () => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = 'ap-south-1';

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials not configured in environment');
  }

  return new AWSService(accessKeyId, secretAccessKey, region);
};

// Generate database-specific commands for Ubuntu
const generateDatabaseCommands = (databaseType, action, params) => {
  const { username, password, privileges = DEFAULT_PRIVILEGES, masterPassword } = params;

  if (databaseType === 'postgresql') {
    switch (action) {
      case 'create_user':
        return [
          // Use createuser command - more reliable than complex SQL
          `sudo -u postgres createuser --login --no-superuser --no-createdb --no-createrole ${username} || echo "User might already exist"`,
          // Set password
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE ${username} WITH PASSWORD '${password}';"`,
          // Grant table privileges
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT ${privileges.join(', ')} ON ALL TABLES IN SCHEMA public TO ${username};"`,
          // Grant schema usage
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA public TO ${username};"`,
          // Grant default privileges for future tables
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privileges.join(', ')} ON TABLES TO ${username};"`
        ];
      case 'delete_user':
        return [
          // Revoke all privileges first
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${username};" || echo "Privileges already revoked"`,
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "REVOKE USAGE ON SCHEMA public FROM ${username};" || echo "Schema usage already revoked"`,
          // Drop the role
          `sudo -u postgres dropuser --if-exists ${username}`
        ];
      case 'change_password':
        return [
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE ${username} WITH PASSWORD '${password}';"`
        ];
      case 'grant_privileges':
        return [
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT ${privileges.join(', ')} ON ALL TABLES IN SCHEMA public TO ${username};"`,
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privileges.join(', ')} ON TABLES TO ${username};"`
        ];
      case 'list_users':
        return [
          `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "SELECT usename as username, usesuper as is_superuser, usecreatedb as can_create_db FROM pg_user ORDER BY usename;"`
        ];
    }
  } else if (databaseType === 'mysql') {
    const rootPassword = masterPassword || process.env.DEFAULT_DB_PASSWORD;
    // Escape special characters in password
    const safeRootPassword = rootPassword.replace(/(["\$`\\])/g, '\\$1');

    switch (action) {
      case 'create_user':
        return [
          `mysql -u root -p${safeRootPassword} -e "CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '${password}';"`,
          `mysql -u root -p${safeRootPassword} -e "GRANT ${privileges.join(', ')} ON *.* TO '${username}'@'%';"`,
          `mysql -u root -p${safeRootPassword} -e "FLUSH PRIVILEGES;"`
        ];
      case 'delete_user':
        return [
          `mysql -u root -p${safeRootPassword} -e "DROP USER IF EXISTS '${username}'@'%';"`,
          `mysql -u root -p${safeRootPassword} -e "FLUSH PRIVILEGES;"`
        ];
      case 'change_password':
        return [
          `mysql -u root -p${safeRootPassword} -e "ALTER USER '${username}'@'%' IDENTIFIED BY '${password}';"`,
          `mysql -u root -p${safeRootPassword} -e "FLUSH PRIVILEGES;"`
        ];
      case 'grant_privileges':
        return [
          `mysql -u root -p${safeRootPassword} -e "GRANT ${privileges.join(', ')} ON *.* TO '${username}'@'%';"`,
          `mysql -u root -p${safeRootPassword} -e "FLUSH PRIVILEGES;"`
        ];
      case 'list_users':
        return [
          `mysql -u root -p${safeRootPassword} -e "SELECT User as username, Host FROM mysql.user ORDER BY User;"`
        ];
    }
  }

  throw new Error(`Unsupported database type: ${databaseType}`);
};

// ------------------- ROUTES -------------------

// Create database user
router.post('/:instanceId/users', authenticateToken, [
  body('username')
    .isLength({ min: 3, max: 16 })
    .matches(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .withMessage('Username must be 3-16 characters and start with a letter'),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character'),
  body('privileges').optional().isArray().withMessage('Privileges must be an array')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: { 
          message: 'Validation failed', 
          details: errors.array(), 
          status: 400 
        } 
      });
    }

    const { instanceId } = req.params;
    const { username, password, privileges } = req.body;

    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    if (instance.status !== 'running') {
      return res.status(400).json({ 
        error: { 
          message: 'Instance must be running to manage database users', 
          status: 400 
        } 
      });
    }

    const existingUser = instance.databaseUsers.find(u => u.username === username);
    if (existingUser) {
      return res.status(409).json({ 
        error: { 
          message: 'Database user already exists', 
          status: 409 
        } 
      });
    }

    // Validate privileges for the specific database type
    const validPrivileges = instance.databaseType === 'postgresql' 
      ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
      : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX'];

    const requestedPrivileges = privileges || DEFAULT_PRIVILEGES;
    const invalidPrivileges = requestedPrivileges.filter(p => !validPrivileges.includes(p.toUpperCase()));
    
    if (invalidPrivileges.length > 0) {
      return res.status(400).json({
        error: {
          message: `Invalid privileges for ${instance.databaseType}: ${invalidPrivileges.join(', ')}`,
          validPrivileges,
          status: 400
        }
      });
    }

    const commands = generateDatabaseCommands(instance.databaseType, 'create_user', {
      username,
      password,
      privileges: requestedPrivileges,
      masterPassword: instance.masterPassword
    });

    console.log(`[DB] Creating database user '${username}' on instance ${instanceId}`);
    console.log(`[DB] Generated commands:`, commands);

    const awsService = getAWSService();
    let commandResult;
    
    try {
      commandResult = await awsService.executeCommand(instanceId, commands);
      console.log(`[DB] SSM command completed, CommandId: ${commandResult.CommandId}`);
      
      // Add user to database record only after successful command execution
      await instance.addDatabaseUser(username, password, requestedPrivileges);
      
      res.status(201).json({
        message: 'Database user creation initiated',
        user: { 
          username, 
          privileges: requestedPrivileges, 
          createdAt: new Date() 
        },
        commandId: commandResult.CommandId
      });
      
    } catch (ssmError) {
      console.error(`[DB] SSM command failed:`, ssmError.message);
      
      // For PostgreSQL, still add user to record as the createuser command might succeed partially
      if (instance.databaseType === 'postgresql') {
        await instance.addDatabaseUser(username, password, requestedPrivileges);
        return res.status(202).json({
          message: 'Database user creation queued (SSM execution uncertain)',
          user: { 
            username, 
            privileges: requestedPrivileges, 
            createdAt: new Date() 
          },
          error: ssmError.message,
          note: 'User added to database record. Please verify creation manually if needed.'
        });
      }
      
      // For MySQL or other critical errors, don't add to record
      return res.status(500).json({
        error: { 
          message: 'Database user creation failed', 
          details: ssmError.message,
          status: 500 
        }
      });
    }
  } catch (error) {
    console.error('Create database user error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to create database user', 
        status: 500 
      } 
    });
  }
});

// List database users
router.get('/:instanceId/users', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    res.json({
      users: instance.databaseUsers.map(user => ({
        username: user.username,
        privileges: user.privileges,
        createdAt: user.createdAt
      })),
      masterUsername: instance.masterUsername,
      databaseType: instance.databaseType,
      totalUsers: instance.databaseUsers.length
    });
  } catch (error) {
    console.error('List database users error:', error);
    res.status(500).json({ 
      error: { 
        message: 'Failed to list database users', 
        status: 500 
      } 
    });
  }
});

// Update database user privileges and/or password
router.put('/:instanceId/users/:username', authenticateToken, [
  body('privileges').optional().isArray().withMessage('Privileges must be an array'),
  body('password').optional()
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: { 
          message: 'Validation failed', 
          details: errors.array(), 
          status: 400 
        } 
      });
    }

    const { instanceId, username } = req.params;
    const { privileges, password } = req.body;

    if (!privileges && !password) {
      return res.status(400).json({
        error: {
          message: 'Either privileges or password must be provided',
          status: 400
        }
      });
    }

    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    if (instance.status !== 'running') {
      return res.status(400).json({ 
        error: { 
          message: 'Instance must be running to manage database users', 
          status: 400 
        } 
      });
    }

    const userIndex = instance.databaseUsers.findIndex(u => u.username === username);
    if (userIndex === -1) {
      return res.status(404).json({ 
        error: { 
          message: 'Database user not found', 
          status: 404 
        } 
      });
    }

    const commands = [];
    const awsService = getAWSService();

    if (privileges) {
      // Validate privileges
      const validPrivileges = instance.databaseType === 'postgresql' 
        ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX'];

      const invalidPrivileges = privileges.filter(p => !validPrivileges.includes(p.toUpperCase()));
      if (invalidPrivileges.length > 0) {
        return res.status(400).json({
          error: {
            message: `Invalid privileges for ${instance.databaseType}: ${invalidPrivileges.join(', ')}`,
            validPrivileges,
            status: 400
          }
        });
      }

      commands.push(...generateDatabaseCommands(instance.databaseType, 'grant_privileges', { 
        username, 
        privileges, 
        masterPassword: instance.masterPassword 
      }));
      instance.databaseUsers[userIndex].privileges = privileges;
    }

    if (password) {
      commands.push(...generateDatabaseCommands(instance.databaseType, 'change_password', { 
        username, 
        password, 
        masterPassword: instance.masterPassword 
      }));
      instance.databaseUsers[userIndex].password = password;
    }

    let commandResult = null;
    if (commands.length > 0) {
      try {
        commandResult = await awsService.executeCommand(instanceId, commands);
        await instance.save();
      } catch (ssmError) {
        console.error('Update database user SSM error:', ssmError);
        return res.status(500).json({
          error: {
            message: 'Failed to update database user',
            details: ssmError.message,
            status: 500
          }
        });
      }
    }

    res.json({
      message: 'Database user update initiated',
      user: {
        username: instance.databaseUsers[userIndex].username,
        privileges: instance.databaseUsers[userIndex].privileges,
        createdAt: instance.databaseUsers[userIndex].createdAt
      },
      commandId: commandResult ? commandResult.CommandId : null
    });
  } catch (error) {
    console.error('Update database user error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to update database user', 
        status: 500 
      } 
    });
  }
});

// Delete database user
router.delete('/:instanceId/users/:username', authenticateToken, async (req, res) => {
  try {
    const { instanceId, username } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    if (instance.status !== 'running') {
      return res.status(400).json({ 
        error: { 
          message: 'Instance must be running to manage database users', 
          status: 400 
        } 
      });
    }

    if (username === instance.masterUsername) {
      return res.status(400).json({ 
        error: { 
          message: 'Cannot delete master database user', 
          status: 400 
        } 
      });
    }

    const userExists = instance.databaseUsers.find(u => u.username === username);
    if (!userExists) {
      return res.status(404).json({
        error: {
          message: 'Database user not found',
          status: 404
        }
      });
    }

    const commands = generateDatabaseCommands(instance.databaseType, 'delete_user', { 
      username, 
      masterPassword: instance.masterPassword 
    });

    const awsService = getAWSService();
    
    try {
      const commandResult = await awsService.executeCommand(instanceId, commands);
      await instance.removeDatabaseUser(username);

      res.json({
        message: 'Database user deletion initiated',
        commandId: commandResult.CommandId
      });
    } catch (ssmError) {
      console.error('Delete database user SSM error:', ssmError);
      return res.status(500).json({
        error: {
          message: 'Failed to delete database user',
          details: ssmError.message,
          status: 500
        }
      });
    }
  } catch (error) {
    console.error('Delete database user error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to delete database user', 
        status: 500 
      } 
    });
  }
});

// Get database connection info
router.get('/:instanceId/connection', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    if (!instance.networkConfig.publicIp) {
      return res.status(400).json({ 
        error: { 
          message: 'Instance does not have a public IP address yet', 
          status: 400 
        } 
      });
    }

    const defaultPort = instance.databaseType === 'postgresql' ? 5432 : 3306;

    res.json({
      connectionInfo: {
        host: instance.networkConfig.publicIp,
        port: instance.databasePort || defaultPort,
        databaseType: instance.databaseType,
        masterUsername: instance.masterUsername,
        connectionString: instance.connectionString,
        sslMode: instance.databaseType === 'postgresql' ? 'prefer' : 'PREFERRED'
      },
      users: instance.databaseUsers.map(u => ({ 
        username: u.username, 
        privileges: u.privileges, 
        createdAt: u.createdAt 
      })),
      status: instance.status
    });
  } catch (error) {
    console.error('Get connection info error:', error);
    res.status(500).json({ 
      error: { 
        message: 'Failed to get connection information', 
        status: 500 
      } 
    });
  }
});

// Execute arbitrary database command
router.post('/:instanceId/execute', authenticateToken, [
  body('command').notEmpty().withMessage('Command is required'),
  body('database').optional().isLength({ min: 1 }).withMessage('Database name must be provided if specified')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: { 
          message: 'Validation failed', 
          details: errors.array(), 
          status: 400 
        } 
      });
    }

    const { instanceId } = req.params;
    const { command, database } = req.body;

    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    if (instance.status !== 'running') {
      return res.status(400).json({ 
        error: { 
          message: 'Instance must be running to execute commands', 
          status: 400 
        } 
      });
    }

    // Security check - prevent dangerous commands
    const dangerousPatterns = [
      /DROP\s+DATABASE/i,
      /DROP\s+SCHEMA/i,
      /TRUNCATE\s+pg_/i,
      /DELETE\s+FROM\s+pg_/i,
      /rm\s+-rf/i,
      /sudo\s+/i
    ];

    if (dangerousPatterns.some(pattern => pattern.test(command))) {
      return res.status(403).json({
        error: {
          message: 'Command contains potentially dangerous operations',
          status: 403
        }
      });
    }

    let dbCommand;
    if (instance.databaseType === 'postgresql') {
      dbCommand = `sudo -u postgres psql ${database ? `-d ${database}` : ''} -v ON_ERROR_STOP=1 -c "${command.replace(/"/g, '\\"')}"`;
    } else if (instance.databaseType === 'mysql') {
      const safePassword = instance.masterPassword.replace(/(["\$`\\])/g, '\\$1');
      dbCommand = `mysql -u ${instance.masterUsername} -p${safePassword} ${database ? `-D ${database}` : ''} -e "${command.replace(/"/g, '\\"')}"`;
    }

    const awsService = getAWSService();
    
    try {
      const commandResult = await awsService.executeCommand(instanceId, [dbCommand]);

      res.json({
        message: 'Database command execution initiated',
        commandId: commandResult.CommandId,
        command: dbCommand
      });
    } catch (ssmError) {
      console.error('Execute database command SSM error:', ssmError);
      return res.status(500).json({
        error: {
          message: 'Failed to execute database command',
          details: ssmError.message,
          status: 500
        }
      });
    }
  } catch (error) {
    console.error('Execute database command error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to execute database command', 
        status: 500 
      } 
    });
  }
});

// Check SSM agent status (quick check)
router.get('/:instanceId/ssm-status', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    const awsService = getAWSService();
    const { DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');
    
    try {
      const resp = await awsService.ssmClient.send(new DescribeInstanceInformationCommand({
        Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
      }));

      if (resp.InstanceInformationList && resp.InstanceInformationList.length > 0) {
        const ssmInstance = resp.InstanceInformationList[0];
        res.json({
          ssmRegistered: true,
          pingStatus: ssmInstance.PingStatus,
          agentVersion: ssmInstance.AgentVersion,
          platform: `${ssmInstance.PlatformName} ${ssmInstance.PlatformVersion}`,
          lastPing: ssmInstance.LastPingDateTime,
          isOnline: ssmInstance.PingStatus === 'Online'
        });
      } else {
        res.json({
          ssmRegistered: false,
          message: 'Instance not registered with SSM yet'
        });
      }
    } catch (ssmError) {
      console.error('SSM status check error:', ssmError);
      res.status(500).json({
        error: {
          message: 'Failed to check SSM status',
          details: ssmError.message,
          status: 500
        }
      });
    }
  } catch (error) {
    console.error('SSM status check error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to check SSM status', 
        status: 500 
      } 
    });
  }
});

// Get command execution status and results
router.get('/:instanceId/commands/:commandId', authenticateToken, async (req, res) => {
  try {
    const { instanceId, commandId } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    const awsService = getAWSService();
    const { GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
    
    try {
      const result = await awsService.ssmClient.send(new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId
      }));

      res.json({
        commandId: result.CommandId,
        instanceId: result.InstanceId,
        status: result.Status,
        statusMessage: result.StatusDetails,
        isComplete: ['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(result.Status),
        output: result.StandardOutputContent || '',
        error: result.StandardErrorContent || '',
        executionStartTime: result.ExecutionStartDateTime,
        executionEndTime: result.ExecutionEndDateTime,
        responseCode: result.ResponseCode
      });
    } catch (ssmError) {
      console.error('Get command status error:', ssmError);
      if (ssmError.name === 'InvocationDoesNotExist') {
        return res.status(404).json({
          error: {
            message: 'Command invocation not found',
            status: 404
          }
        });
      }
      
      res.status(500).json({
        error: {
          message: 'Failed to get command status',
          details: ssmError.message,
          status: 500
        }
      });
    }
  } catch (error) {
    console.error('Get command status error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to get command status', 
        status: 500 
      } 
    });
  }
});

// Fix permissions for existing users (new route)
router.post('/:instanceId/users/:username/fix-permissions', authenticateToken, async (req, res) => {
  try {
    const { instanceId, username } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    
    if (!instance) {
      return res.status(404).json({ 
        error: { 
          message: 'Instance not found', 
          status: 404 
        } 
      });
    }

    if (instance.status !== 'running') {
      return res.status(400).json({ 
        error: { 
          message: 'Instance must be running to fix permissions', 
          status: 400 
        } 
      });
    }

    const user = instance.databaseUsers.find(u => u.username === username);
    if (!user) {
      return res.status(404).json({
        error: {
          message: 'Database user not found',
          status: 404
        }
      });
    }

    if (instance.databaseType === 'postgresql') {
      const privileges = user.privileges || DEFAULT_PRIVILEGES;
      const fixCommands = [
        // Grant schema usage
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA public TO ${username};"`,
        // Re-grant privileges on ALL existing tables
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT ${privileges.join(', ')} ON ALL TABLES IN SCHEMA public TO ${username};"`,
        // Grant privileges on ALL existing sequences
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${username};"`,
        // Fix default privileges for future tables created by postgres user
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ${privileges.join(', ')} ON TABLES TO ${username};"`,
        // Fix default privileges for future tables created by any user
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privileges.join(', ')} ON TABLES TO ${username};"`,
        // Fix default privileges for future sequences
        `sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${username};"`
      ];

      const awsService = getAWSService();
      
      try {
        const commandResult = await awsService.executeCommand(instanceId, fixCommands);
        
        res.json({
          message: `Permissions fix initiated for user '${username}'`,
          commandId: commandResult.CommandId,
          note: 'This will grant permissions on all existing and future tables/sequences'
        });
      } catch (ssmError) {
        console.error('Fix permissions SSM error:', ssmError);
        return res.status(500).json({
          error: {
            message: 'Failed to fix permissions',
            details: ssmError.message,
            status: 500
          }
        });
      }
    } else {
      return res.status(400).json({
        error: {
          message: 'Permission fix currently only supported for PostgreSQL',
          status: 400
        }
      });
    }
  } catch (error) {
    console.error('Fix permissions error:', error);
    res.status(500).json({ 
      error: { 
        message: error.message || 'Failed to fix permissions', 
        status: 500 
      } 
    });
  }
});

module.exports = router;