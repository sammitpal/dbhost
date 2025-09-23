const mongoose = require('mongoose');

const databaseUserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true
  },
  password: {
    type: String,
    required: true
  },
  privileges: {
    type: [String],
    default: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const networkConfigSchema = new mongoose.Schema({
  vpcId: {
    type: String,
    required: true
  },
  subnetId: {
    type: String,
    required: true
  },
  securityGroupIds: [{
    type: String
  }],
  publicIp: {
    type: String
  },
  privateIp: {
    type: String
  },
  ports: [{
    port: Number,
    protocol: {
      type: String,
      enum: ['tcp', 'udp'],
      default: 'tcp'
    },
    description: String
  }]
});

const ec2InstanceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  instanceId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  instanceType: {
    type: String,
    default: 't3.micro'
  },
  region: {
    type: String,
    default: 'ap-south-1'
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'stopping', 'stopped', 'terminating', 'terminated'],
    default: 'pending'
  },
  databaseType: {
    type: String,
    enum: ['postgresql', 'mysql'],
    required: true
  },
  databaseVersion: {
    type: String,
    required: true
  },
  databasePort: {
    type: Number,
    required: true
  },
  masterUsername: {
    type: String,
    required: true
  },
  masterPassword: {
    type: String,
    required: true
  },
  databaseUsers: [databaseUserSchema],
  networkConfig: networkConfigSchema,
  keyPairName: {
    type: String,
    required: true
  },
  userData: {
    type: String
  },
  tags: [{
    key: String,
    value: String
  }],
  launchTime: {
    type: Date
  },
  terminationTime: {
    type: Date
  },
  lastStatusCheck: {
    type: Date,
    default: Date.now
  },
  monitoring: {
    enabled: {
      type: Boolean,
      default: false
    },
    logGroupName: String
  }
}, {
  timestamps: true
});

// Index for efficient queries
ec2InstanceSchema.index({ userId: 1, status: 1 });
ec2InstanceSchema.index({ instanceId: 1 });

// Virtual for database connection string
ec2InstanceSchema.virtual('connectionString').get(function() {
  if (!this.networkConfig || !this.networkConfig.publicIp) {
    return null;
  }
  
  const host = this.networkConfig.publicIp;
  const port = this.databasePort;
  const username = this.masterUsername;
  const dbName = this.databaseType === 'postgresql' ? 'postgres' : 'mysql';
  
  if (this.databaseType === 'postgresql') {
    return `postgresql://${username}:${this.masterPassword}@${host}:${port}/${dbName}`;
  } else {
    return `mysql://${username}:${this.masterPassword}@${host}:${port}/${dbName}`;
  }
});

// Method to add database user
ec2InstanceSchema.methods.addDatabaseUser = function(username, password, privileges = ['SELECT']) {
  this.databaseUsers.push({
    username,
    password,
    privileges
  });
  return this.save();
};

// Method to remove database user
ec2InstanceSchema.methods.removeDatabaseUser = function(username) {
  this.databaseUsers = this.databaseUsers.filter(user => user.username !== username);
  return this.save();
};

// Remove sensitive data when converting to JSON
ec2InstanceSchema.methods.toJSON = function() {
  const instance = this.toObject({ virtuals: true });
  // Keep master password hidden in responses, but show connection string
  delete instance.masterPassword;
  // Hide individual database user passwords
  if (instance.databaseUsers) {
    instance.databaseUsers.forEach(user => {
      delete user.password;
    });
  }
  return instance;
};

module.exports = mongoose.model('EC2Instance', ec2InstanceSchema); 