const express = require('express');
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

// Get logs for an instance
router.get('/:instanceId', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { startTime, endTime, limit = 100 } = req.query;
    
    const instance = await EC2Instance.findOne({
      instanceId,
      userId: req.user._id
    });

    if (!instance) {
      return res.status(404).json({
        error: {
          message: 'Instance not found',
          status: 404
        }
      });
    }

    // Get logs from CloudWatch if available
    const awsService = getAWSService();
    
    try {
      // Try to get logs from multiple log streams
      const logStreams = [
        `/aws/ec2/${instanceId}`,
        `/var/log/dbhost/install.log`,
        `/var/log/messages`
      ];

      const allLogs = [];
      
      for (const logStreamName of logStreams) {
        try {
          const logs = await awsService.getLogs(
            logStreamName,
            instanceId,
            startTime ? new Date(startTime).getTime() : undefined,
            endTime ? new Date(endTime).getTime() : undefined
          );
          
          allLogs.push(...logs.map(log => ({
            ...log,
            logStream: logStreamName
          })));
        } catch (logError) {
          // Continue if this log stream doesn't exist
          console.log(`Log stream ${logStreamName} not available:`, logError.message);
        }
      }

      // Sort logs by timestamp
      allLogs.sort((a, b) => a.timestamp - b.timestamp);

      res.json({
        logs: allLogs.slice(0, parseInt(limit)),
        instanceId,
        totalLogs: allLogs.length
      });
    } catch (error) {
      // If CloudWatch logs are not available, try to get logs via SSM
      console.log('CloudWatch logs not available, trying SSM:', error.message);
      
      const commands = [
        'tail -n 50 /var/log/dbhost/install.log',
        'tail -n 50 /var/log/messages',
        'systemctl status postgresql || systemctl status mysqld'
      ];

      const commandResult = await awsService.executeCommand(instanceId, commands);
      
      res.json({
        message: 'Logs retrieved via SSM',
        commandId: commandResult.CommandId,
        instanceId,
        note: 'Use /logs/:instanceId/command/:commandId to get command results'
      });
    }
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get logs',
        status: 500
      }
    });
  }
});

// Get command execution result
router.get('/:instanceId/command/:commandId', authenticateToken, async (req, res) => {
  try {
    const { instanceId, commandId } = req.params;
    
    const instance = await EC2Instance.findOne({
      instanceId,
      userId: req.user._id
    });

    if (!instance) {
      return res.status(404).json({
        error: {
          message: 'Instance not found',
          status: 404
        }
      });
    }

    const awsService = getAWSService();
    const result = await awsService.getCommandResult(commandId, instanceId);

    res.json({
      commandId,
      instanceId,
      status: result.Status,
      output: result.StandardOutputContent,
      error: result.StandardErrorContent,
      executionStartTime: result.ExecutionStartDateTime,
      executionEndTime: result.ExecutionEndDateTime
    });
  } catch (error) {
    console.error('Get command result error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get command result',
        status: 500
      }
    });
  }
});

// Stream real-time logs via WebSocket
router.get('/:instanceId/stream', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    
    const instance = await EC2Instance.findOne({
      instanceId,
      userId: req.user._id
    });

    if (!instance) {
      return res.status(404).json({
        error: {
          message: 'Instance not found',
          status: 404
        }
      });
    }

    // Get WebSocket server from app
    const wss = req.app.get('wss');
    
    if (!wss) {
      return res.status(500).json({
        error: {
          message: 'WebSocket server not available',
          status: 500
        }
      });
    }

    // Start log streaming
    const awsService = getAWSService();
    
    // Set up periodic log fetching
    const logInterval = setInterval(async () => {
      try {
        const logs = await awsService.getLogs(
          `/var/log/dbhost/install.log`,
          instanceId,
          Date.now() - 60000 // Last minute
        );

        // Broadcast to all connected clients for this instance
        wss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify({
              type: 'logs',
              instanceId,
              logs,
              timestamp: new Date().toISOString()
            }));
          }
        });
      } catch (logError) {
        console.error('Error streaming logs:', logError);
      }
    }, 5000); // Every 5 seconds

    // Store interval ID for cleanup
    res.json({
      message: 'Log streaming started',
      instanceId,
      streamingInterval: 5000,
      note: 'Connect to WebSocket to receive real-time logs'
    });

    // Clean up interval after 30 minutes
    setTimeout(() => {
      clearInterval(logInterval);
    }, 30 * 60 * 1000);
  } catch (error) {
    console.error('Stream logs error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to start log streaming',
        status: 500
      }
    });
  }
});

// Get database logs specifically
router.get('/:instanceId/database', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { lines = 50 } = req.query;
    
    const instance = await EC2Instance.findOne({
      instanceId,
      userId: req.user._id
    });

    if (!instance) {
      return res.status(404).json({
        error: {
          message: 'Instance not found',
          status: 404
        }
      });
    }

    const awsService = getAWSService(req.user);
    
    // Get database-specific logs
    let commands;
    if (instance.databaseType === 'postgresql') {
      commands = [
        `tail -n ${lines} /var/lib/pgsql/data/log/postgresql-*.log || echo "No PostgreSQL logs found"`,
        'systemctl status postgresql',
        'sudo -u postgres psql -c "SELECT * FROM pg_stat_activity;"'
      ];
    } else if (instance.databaseType === 'mysql') {
      commands = [
        `tail -n ${lines} /var/log/mysqld.log || echo "No MySQL logs found"`,
        'systemctl status mysqld',
        `mysql -u ${instance.masterUsername} -p${instance.masterPassword} -e "SHOW PROCESSLIST;"`
      ];
    }

    const commandResult = await awsService.executeCommand(instanceId, commands);

    res.json({
      message: 'Database logs command executed',
      commandId: commandResult.CommandId,
      instanceId,
      databaseType: instance.databaseType,
      note: 'Use /logs/:instanceId/command/:commandId to get results'
    });
  } catch (error) {
    console.error('Get database logs error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get database logs',
        status: 500
      }
    });
  }
});

// Get system logs
router.get('/:instanceId/system', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { lines = 50 } = req.query;
    
    const instance = await EC2Instance.findOne({
      instanceId,
      userId: req.user._id
    });

    if (!instance) {
      return res.status(404).json({
        error: {
          message: 'Instance not found',
          status: 404
        }
      });
    }

    const awsService = getAWSService();
    
    const commands = [
      `tail -n ${lines} /var/log/messages`,
      `tail -n ${lines} /var/log/cloud-init-output.log`,
      `tail -n ${lines} /var/log/dbhost/install.log`,
      'df -h',
      'free -m',
      'uptime',
      'systemctl --failed'
    ];

    const commandResult = await awsService.executeCommand(instanceId, commands);

    res.json({
      message: 'System logs command executed',
      commandId: commandResult.CommandId,
      instanceId,
      note: 'Use /logs/:instanceId/command/:commandId to get results'
    });
  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get system logs',
        status: 500
      }
    });
  }
});

module.exports = router; 