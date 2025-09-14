const express = require('express');
const { body, validationResult } = require('express-validator');
const EC2Instance = require('../models/EC2Instance');
const AWSService = require('../services/awsService');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

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

// Generate database-specific commands
const generateDatabaseCommands = (databaseType, action, params) => {
  const { username, password, privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } = params;
  
  if (databaseType === 'postgresql') {
    switch (action) {
      case 'create_user':
        return [
          `sudo -u postgres psql -c "CREATE USER ${username} WITH PASSWORD '${password}';"`,
          `sudo -u postgres psql -c "GRANT ${privileges.join(', ')} ON ALL TABLES IN SCHEMA public TO ${username};"`,
          `sudo -u postgres psql -c "GRANT USAGE ON SCHEMA public TO ${username};"`
        ];
      case 'delete_user':
        return [`sudo -u postgres psql -c "DROP USER IF EXISTS ${username};"`];
      case 'change_password':
        return [`sudo -u postgres psql -c "ALTER USER ${username} WITH PASSWORD '${password}';"`];
      case 'grant_privileges':
        return [`sudo -u postgres psql -c "GRANT ${privileges.join(', ')} ON ALL TABLES IN SCHEMA public TO ${username};"`];
      case 'list_users':
        return [`sudo -u postgres psql -c "SELECT usename, usesuper, usecreatedb FROM pg_user;"`];
    }
  } else if (databaseType === 'mysql') {
    switch (action) {
      case 'create_user':
        return [
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "CREATE USER '${username}'@'%' IDENTIFIED BY '${password}';"`,
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "GRANT ${privileges.join(', ')} ON *.* TO '${username}'@'%';"`,
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "FLUSH PRIVILEGES;"`
        ];
      case 'delete_user':
        return [
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "DROP USER IF EXISTS '${username}'@'%';"`,
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "FLUSH PRIVILEGES;"`
        ];
      case 'change_password':
        return [
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "ALTER USER '${username}'@'%' IDENTIFIED BY '${password}';"`,
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "FLUSH PRIVILEGES;"`
        ];
      case 'grant_privileges':
        return [
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "GRANT ${privileges.join(', ')} ON *.* TO '${username}'@'%';"`,
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "FLUSH PRIVILEGES;"`
        ];
      case 'list_users':
        return [
          `mysql -u root -p${process.env.DEFAULT_DB_PASSWORD} -e "SELECT User, Host FROM mysql.user;"`
        ];
    }
  }
  
  throw new Error(`Unsupported database type: ${databaseType}`);
};

// Create database user
router.post('/:instanceId/users', authenticateToken, [
  body('username')
    .isLength({ min: 3, max: 16 })
    .matches(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .withMessage('Username must be 3-16 characters and start with a letter'),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character'),
  body('privileges')
    .optional()
    .isArray()
    .withMessage('Privileges must be an array')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { message: 'Validation failed', details: errors.array(), status: 400 } });
    }

    const { instanceId } = req.params;
    const { username, password, privileges } = req.body;
    
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) return res.status(404).json({ error: { message: 'Instance not found', status: 404 } });
    if (instance.status !== 'running') return res.status(400).json({ error: { message: 'Instance must be running to manage database users', status: 400 } });

    const existingUser = instance.databaseUsers.find(u => u.username === username);
    if (existingUser) return res.status(409).json({ error: { message: 'Database user already exists', status: 409 } });

    const commands = generateDatabaseCommands(instance.databaseType, 'create_user', {
      username,
      password,
      privileges: privileges || ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    });

    const awsService = getAWSService();
    const commandResult = await awsService.executeCommand(instanceId, commands);

    await instance.addDatabaseUser(username, password, privileges);

    res.status(201).json({
      message: 'Database user created successfully',
      user: { username, privileges: privileges || ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], createdAt: new Date() },
      commandId: commandResult.CommandId
    });
  } catch (error) {
    console.error('Create database user error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to create database user', status: 500 } });
  }
});

// List database users
router.get('/:instanceId/users', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) return res.status(404).json({ error: { message: 'Instance not found', status: 404 } });

    res.json({
      users: instance.databaseUsers,
      masterUsername: instance.masterUsername,
      databaseType: instance.databaseType
    });
  } catch (error) {
    console.error('List database users error:', error);
    res.status(500).json({ error: { message: 'Failed to list database users', status: 500 } });
  }
});

// Update database user privileges and/or password
router.put('/:instanceId/users/:username', authenticateToken, [
  body('privileges').optional().isArray().withMessage('Privileges must be an array'),
  body('password').optional().isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/).withMessage('Password must be at least 8 characters with uppercase, lowercase, number, and special character')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: { message: 'Validation failed', details: errors.array(), status: 400 } });

    const { instanceId, username } = req.params;
    const { privileges, password } = req.body;

    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) return res.status(404).json({ error: { message: 'Instance not found', status: 404 } });
    if (instance.status !== 'running') return res.status(400).json({ error: { message: 'Instance must be running to manage database users', status: 400 } });

    const userIndex = instance.databaseUsers.findIndex(u => u.username === username);
    if (userIndex === -1) return res.status(404).json({ error: { message: 'Database user not found', status: 404 } });

    const commands = [];
    const awsService = getAWSService();

    if (privileges) {
      commands.push(...generateDatabaseCommands(instance.databaseType, 'grant_privileges', { username, privileges }));
      instance.databaseUsers[userIndex].privileges = privileges;
    }

    if (password) {
      commands.push(...generateDatabaseCommands(instance.databaseType, 'change_password', { username, password }));
      instance.databaseUsers[userIndex].password = password;
    }

    let commandResult = null;
    if (commands.length > 0) commandResult = await awsService.executeCommand(instanceId, commands);

    await instance.save();

    res.json({
      message: 'Database user updated successfully',
      user: instance.databaseUsers[userIndex],
      commandId: commandResult ? commandResult.CommandId : null
    });
  } catch (error) {
    console.error('Update database user error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to update database user', status: 500 } });
  }
});

// Delete database user
router.delete('/:instanceId/users/:username', authenticateToken, async (req, res) => {
  try {
    const { instanceId, username } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) return res.status(404).json({ error: { message: 'Instance not found', status: 404 } });
    if (instance.status !== 'running') return res.status(400).json({ error: { message: 'Instance must be running to manage database users', status: 400 } });

    if (username === instance.masterUsername) return res.status(400).json({ error: { message: 'Cannot delete master database user', status: 400 } });

    const commands = generateDatabaseCommands(instance.databaseType, 'delete_user', { username });
    const awsService = getAWSService();
    const commandResult = await awsService.executeCommand(instanceId, commands);

    await instance.removeDatabaseUser(username);

    res.json({ message: 'Database user deleted successfully', commandId: commandResult.CommandId });
  } catch (error) {
    console.error('Delete database user error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to delete database user', status: 500 } });
  }
});

// Get database connection info
router.get('/:instanceId/connection', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) return res.status(404).json({ error: { message: 'Instance not found', status: 404 } });

    if (!instance.networkConfig.publicIp) return res.status(400).json({ error: { message: 'Instance does not have a public IP address yet', status: 400 } });

    res.json({
      connectionInfo: {
        host: instance.networkConfig.publicIp,
        port: instance.databasePort,
        databaseType: instance.databaseType,
        masterUsername: instance.masterUsername,
        connectionString: instance.connectionString,
        sslMode: instance.databaseType === 'postgresql' ? 'prefer' : 'PREFERRED'
      },
      users: instance.databaseUsers.map(u => ({ username: u.username, privileges: u.privileges, createdAt: u.createdAt }))
    });
  } catch (error) {
    console.error('Get connection info error:', error);
    res.status(500).json({ error: { message: 'Failed to get connection information', status: 500 } });
  }
});

// Execute arbitrary database command
router.post('/:instanceId/execute', authenticateToken, [
  body('command').notEmpty().withMessage('Command is required'),
  body('database').optional().isLength({ min: 1 }).withMessage('Database name must be provided if specified')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: { message: 'Validation failed', details: errors.array(), status: 400 } });

    const { instanceId } = req.params;
    const { command, database } = req.body;

    const instance = await EC2Instance.findOne({ instanceId, userId: req.user._id });
    if (!instance) return res.status(404).json({ error: { message: 'Instance not found', status: 404 } });
    if (instance.status !== 'running') return res.status(400).json({ error: { message: 'Instance must be running to execute commands', status: 400 } });

    let dbCommand;
    if (instance.databaseType === 'postgresql') dbCommand = `sudo -u postgres psql ${database ? `-d ${database}` : ''} -c "${command}"`;
    else if (instance.databaseType === 'mysql') dbCommand = `mysql -u ${instance.masterUsername} -p${instance.masterPassword} ${database ? `-D ${database}` : ''} -e "${command}"`;

    const awsService = getAWSService();
    const commandResult = await awsService.executeCommand(instanceId, [dbCommand]);

    res.json({ message: 'Command executed successfully', commandId: commandResult.CommandId, command: dbCommand });
  } catch (error) {
    console.error('Execute database command error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to execute database command', status: 500 } });
  }
});

module.exports = router;
