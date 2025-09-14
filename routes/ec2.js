const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
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

// Create new EC2 instance with database
router.post('/create', authenticateToken, [
  body('name')
    .isLength({ min: 1, max: 50 })
    .withMessage('Instance name is required and must be less than 50 characters'),
  body('databaseType')
    .isIn(['postgresql', 'mysql'])
    .withMessage('Database type must be either postgresql or mysql'),
  body('databaseVersion')
    .notEmpty()
    .withMessage('Database version is required'),
  body('instanceType')
    .optional()
    .isIn(['t3.micro', 't3.small', 't3.medium', 't3.large'])
    .withMessage('Invalid instance type'),
  body('masterUsername')
    .isLength({ min: 3, max: 16 })
    .matches(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .withMessage('Master username must be 3-16 characters and start with a letter'),
  body('masterPassword')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
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

    const {
      name,
      databaseType,
      databaseVersion,
      instanceType = 't3.micro',
      masterUsername,
      masterPassword
    } = req.body;

    // Use fixed owner account infrastructure
    const vpcId = process.env.VPC_ID;
    const subnetId = process.env.SUBNET_ID;
    const keyPairName = process.env.KEY_PAIR_NAME;

    if (!vpcId || !subnetId || !keyPairName) {
      return res.status(500).json({
        error: {
          message: 'Server configuration error: AWS infrastructure not configured',
          status: 500
        }
      });
    }

    // Get default database port
    const databasePort = databaseType === 'postgresql' ? 5432 : 3306;

    // Initialize AWS service
    const awsService = getAWSService();

    // Launch EC2 instance
    const launchResult = await awsService.launchInstance({
      name,
      instanceType,
      keyPairName,
      vpcId,
      subnetId,
      databaseType,
      databaseVersion,
      databasePort,
      masterUsername,
      masterPassword
    });

    // Save instance to database
    const ec2Instance = new EC2Instance({
      userId: req.user._id,
      instanceId: launchResult.instanceId,
      name,
      instanceType,
      region: 'ap-south-1',
      databaseType,
      databaseVersion,
      databasePort,
      masterUsername,
      masterPassword,
      networkConfig: {
        vpcId,
        subnetId,
        securityGroupIds: [launchResult.securityGroupId]
      },
      keyPairName,
      userData: launchResult.userData,
      tags: [
        { key: 'Name', value: name },
        { key: 'DatabaseType', value: databaseType },
        { key: 'ManagedBy', value: 'DBHost' }
      ]
    });

    await ec2Instance.save();

    res.status(201).json({
      message: 'EC2 instance creation initiated',
      instance: ec2Instance,
      awsInstanceId: launchResult.instanceId
    });
  } catch (error) {
    console.error('EC2 creation error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to create EC2 instance',
        status: 500
      }
    });
  }
});

// List all user's EC2 instances
router.get('/list', authenticateToken, async (req, res) => {
  try {
    const { status, databaseType } = req.query;
    
    // Build query
    const query = { userId: req.user._id };
    if (status) query.status = status;
    if (databaseType) query.databaseType = databaseType;

    const instances = await EC2Instance.find(query)
      .sort({ createdAt: -1 })
      .populate('userId', 'username email');

    // Get real-time status from AWS for running instances
    if (instances.length > 0) {
      try {
        const awsService = getAWSService();
        const instanceIds = instances.map(inst => inst.instanceId);
        const awsInstances = await awsService.getInstanceDetails(instanceIds);
        
        // Update status and network info
        for (const instance of instances) {
          const awsInstance = awsInstances.find(aws => aws.instanceId === instance.instanceId);
          if (awsInstance) {
            instance.status = awsInstance.state;
            instance.networkConfig.publicIp = awsInstance.publicIpAddress;
            instance.networkConfig.privateIp = awsInstance.privateIpAddress;
            instance.lastStatusCheck = new Date();
            await instance.save();
          }
        }
      } catch (awsError) {
        console.error('Error fetching AWS status:', awsError);
        // Continue with database status if AWS call fails
      }
    }

    res.json({
      instances,
      total: instances.length
    });
  } catch (error) {
    console.error('List instances error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to list instances',
        status: 500
      }
    });
  }
});

// Get specific instance details
router.get('/:instanceId', authenticateToken, async (req, res) => {
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

    // Get real-time details from AWS
    try {
      const awsService = getAWSService();
      const awsInstances = await awsService.getInstanceDetails(instanceId);
      
      if (awsInstances.length > 0) {
        const awsInstance = awsInstances[0];
        instance.status = awsInstance.state;
        instance.networkConfig.publicIp = awsInstance.publicIpAddress;
        instance.networkConfig.privateIp = awsInstance.privateIpAddress;
        instance.launchTime = awsInstance.launchTime;
        instance.lastStatusCheck = new Date();
        await instance.save();
      }
    } catch (awsError) {
      console.error('Error fetching AWS details:', awsError);
    }

    res.json({ instance });
  } catch (error) {
    console.error('Get instance error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to get instance details',
        status: 500
      }
    });
  }
});

// Start instance
router.post('/:instanceId/start', authenticateToken, async (req, res) => {
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

    if (instance.status === 'running') {
      return res.status(400).json({
        error: {
          message: 'Instance is already running',
          status: 400
        }
      });
    }

    const awsService = getAWSService();
    const result = await awsService.startInstance(instanceId);

    instance.status = 'pending';
    await instance.save();

    res.json({
      message: 'Instance start initiated',
      awsResult: result
    });
  } catch (error) {
    console.error('Start instance error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to start instance',
        status: 500
      }
    });
  }
});

// Stop instance
router.post('/:instanceId/stop', authenticateToken, async (req, res) => {
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

    if (instance.status === 'stopped') {
      return res.status(400).json({
        error: {
          message: 'Instance is already stopped',
          status: 400
        }
      });
    }

    const awsService = getAWSService();
    const result = await awsService.stopInstance(instanceId);

    instance.status = 'stopping';
    await instance.save();

    res.json({
      message: 'Instance stop initiated',
      awsResult: result
    });
  } catch (error) {
    console.error('Stop instance error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to stop instance',
        status: 500
      }
    });
  }
});

// Terminate instance
router.delete('/:instanceId', authenticateToken, async (req, res) => {
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

    const awsService = getAWSService();
    const result = await awsService.terminateInstance(instanceId);

    instance.status = 'terminating';
    instance.terminationTime = new Date();
    await instance.save();

    res.json({
      message: 'Instance termination initiated',
      awsResult: result
    });
  } catch (error) {
    console.error('Terminate instance error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to terminate instance',
        status: 500
      }
    });
  }
});

// Update network configuration
router.put('/:instanceId/network', authenticateToken, [
  body('ports')
    .optional()
    .isArray()
    .withMessage('Ports must be an array'),
  body('ports.*.port')
    .isInt({ min: 1, max: 65535 })
    .withMessage('Port must be between 1 and 65535'),
  body('ports.*.protocol')
    .optional()
    .isIn(['tcp', 'udp'])
    .withMessage('Protocol must be tcp or udp')
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
    const { ports } = req.body;
    
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

    // Update network configuration
    if (ports) {
      instance.networkConfig.ports = ports;
    }

    await instance.save();

    res.json({
      message: 'Network configuration updated',
      networkConfig: instance.networkConfig
    });
  } catch (error) {
    console.error('Update network error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to update network configuration',
        status: 500
      }
    });
  }
});

module.exports = router; 