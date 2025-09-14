const { EC2Client, RunInstancesCommand, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, DescribeSecurityGroupsCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { CloudWatchLogsClient, CreateLogGroupCommand, DescribeLogStreamsCommand, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

class AWSService {
  constructor(accessKeyId, secretAccessKey, region = 'us-east-1') {
    this.region = region;
    this.ec2Client = new EC2Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });
    
    this.ssmClient = new SSMClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });
    
    this.logsClient = new CloudWatchLogsClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });
  }

  // Generate user data script for database installation
  generateUserData(databaseType, databaseVersion, masterUsername, masterPassword, databasePort) {
    const baseScript = `#!/bin/bash
yum update -y
yum install -y amazon-cloudwatch-agent

# Install CloudWatch agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:AmazonCloudWatch-linux

# Create log directory
mkdir -p /var/log/dbhost
echo "$(date): Starting database installation" >> /var/log/dbhost/install.log
`;

    if (databaseType === 'postgresql') {
      return baseScript + `
# Install PostgreSQL
amazon-linux-extras install postgresql${databaseVersion} -y
yum install -y postgresql-server postgresql-contrib

# Initialize database
postgresql-setup initdb
systemctl enable postgresql
systemctl start postgresql

# Configure PostgreSQL
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '${masterPassword}';"
sudo -u postgres createuser --createdb --pwprompt ${masterUsername} || true
sudo -u postgres psql -c "ALTER USER ${masterUsername} PASSWORD '${masterPassword}';"

# Configure pg_hba.conf for remote connections
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /var/lib/pgsql/data/postgresql.conf
echo "host all all 0.0.0.0/0 md5" >> /var/lib/pgsql/data/pg_hba.conf
sed -i "s/port = 5432/port = ${databasePort}/" /var/lib/pgsql/data/postgresql.conf

# Restart PostgreSQL
systemctl restart postgresql

echo "$(date): PostgreSQL installation completed" >> /var/log/dbhost/install.log
`;
    } else if (databaseType === 'mysql') {
      return baseScript + `
# Install MySQL
yum install -y mysql-server

# Start MySQL
systemctl enable mysqld
systemctl start mysqld

# Get temporary password
TEMP_PASSWORD=$(grep 'temporary password' /var/log/mysqld.log | awk '{print $NF}')

# Configure MySQL
mysql -u root -p"$TEMP_PASSWORD" --connect-expired-password -e "
ALTER USER 'root'@'localhost' IDENTIFIED BY '${masterPassword}';
CREATE USER '${masterUsername}'@'%' IDENTIFIED BY '${masterPassword}';
GRANT ALL PRIVILEGES ON *.* TO '${masterUsername}'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
"

# Configure MySQL for remote connections
sed -i "s/bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/mysql.conf.d/mysqld.cnf
sed -i "s/port.*/port = ${databasePort}/" /etc/mysql/mysql.conf.d/mysqld.cnf

# Restart MySQL
systemctl restart mysqld

echo "$(date): MySQL installation completed" >> /var/log/dbhost/install.log
`;
    }
  }

  // Create security group for database access
  async createSecurityGroup(vpcId, databaseType, databasePort) {
    try {
      const groupName = `dbhost-${databaseType}-${Date.now()}`;
      const description = `Security group for ${databaseType} database`;

      // Create security group
      const createSgCommand = new CreateSecurityGroupCommand({
        GroupName: groupName,
        Description: description,
        VpcId: vpcId
      });

      const sgResult = await this.ec2Client.send(createSgCommand);
      const securityGroupId = sgResult.GroupId;

      // Add inbound rules
      const rules = [
        {
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SSH access' }]
        },
        {
          IpProtocol: 'tcp',
          FromPort: databasePort,
          ToPort: databasePort,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: `${databaseType} access` }]
        }
      ];

      const authorizeCommand = new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: rules
      });

      await this.ec2Client.send(authorizeCommand);

      return securityGroupId;
    } catch (error) {
      console.error('Error creating security group:', error);
      throw error;
    }
  }

  // Launch EC2 instance
  async launchInstance(params) {
    try {
      const {
        name,
        instanceType = 't3.micro',
        keyPairName,
        vpcId,
        subnetId,
        databaseType,
        databaseVersion,
        databasePort,
        masterUsername,
        masterPassword
      } = params;

      // Create security group
      const securityGroupId = await this.createSecurityGroup(vpcId, databaseType, databasePort);

      // Generate user data
      const userData = this.generateUserData(databaseType, databaseVersion, masterUsername, masterPassword, databasePort);

      // Launch instance
      const runCommand = new RunInstancesCommand({
        ImageId: 'ami-0c02fb55956c7d316', // Amazon Linux 2 AMI
        InstanceType: instanceType,
        KeyName: keyPairName,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: [securityGroupId],
        SubnetId: subnetId,
        UserData: Buffer.from(userData).toString('base64'),
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: [
              { Key: 'Name', Value: name },
              { Key: 'DatabaseType', Value: databaseType },
              { Key: 'ManagedBy', Value: 'DBHost' }
            ]
          }
        ],
        IamInstanceProfile: {
          Name: 'EC2-CloudWatchAgent-Role' // Ensure this role exists
        }
      });

      const result = await this.ec2Client.send(runCommand);
      const instance = result.Instances[0];

      return {
        instanceId: instance.InstanceId,
        securityGroupId,
        userData
      };
    } catch (error) {
      console.error('Error launching instance:', error);
      throw error;
    }
  }

  // Get instance details
  async getInstanceDetails(instanceIds) {
    try {
      const command = new DescribeInstancesCommand({
        InstanceIds: Array.isArray(instanceIds) ? instanceIds : [instanceIds]
      });

      const result = await this.ec2Client.send(command);
      const instances = [];

      result.Reservations.forEach(reservation => {
        reservation.Instances.forEach(instance => {
          instances.push({
            instanceId: instance.InstanceId,
            state: instance.State.Name,
            instanceType: instance.InstanceType,
            publicIpAddress: instance.PublicIpAddress,
            privateIpAddress: instance.PrivateIpAddress,
            launchTime: instance.LaunchTime,
            vpcId: instance.VpcId,
            subnetId: instance.SubnetId,
            securityGroups: instance.SecurityGroups,
            tags: instance.Tags || []
          });
        });
      });

      return instances;
    } catch (error) {
      console.error('Error getting instance details:', error);
      throw error;
    }
  }

  // Start instance
  async startInstance(instanceId) {
    try {
      const command = new StartInstancesCommand({
        InstanceIds: [instanceId]
      });

      const result = await this.ec2Client.send(command);
      return result.StartingInstances[0];
    } catch (error) {
      console.error('Error starting instance:', error);
      throw error;
    }
  }

  // Stop instance
  async stopInstance(instanceId) {
    try {
      const command = new StopInstancesCommand({
        InstanceIds: [instanceId]
      });

      const result = await this.ec2Client.send(command);
      return result.StoppingInstances[0];
    } catch (error) {
      console.error('Error stopping instance:', error);
      throw error;
    }
  }

  // Terminate instance
  async terminateInstance(instanceId) {
    try {
      const command = new TerminateInstancesCommand({
        InstanceIds: [instanceId]
      });

      const result = await this.ec2Client.send(command);
      return result.TerminatingInstances[0];
    } catch (error) {
      console.error('Error terminating instance:', error);
      throw error;
    }
  }

  // Execute command on instance via SSM
  async executeCommand(instanceId, commands) {
    try {
      const command = new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
          commands: Array.isArray(commands) ? commands : [commands]
        }
      });

      const result = await this.ssmClient.send(command);
      return result.Command;
    } catch (error) {
      console.error('Error executing command:', error);
      throw error;
    }
  }

  // Get command execution result
  async getCommandResult(commandId, instanceId) {
    try {
      const command = new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId
      });

      const result = await this.ssmClient.send(command);
      return result;
    } catch (error) {
      console.error('Error getting command result:', error);
      throw error;
    }
  }

  // Get logs from CloudWatch
  async getLogs(logGroupName, logStreamName, startTime, endTime) {
    try {
      const command = new GetLogEventsCommand({
        logGroupName,
        logStreamName,
        startTime,
        endTime,
        limit: 100
      });

      const result = await this.logsClient.send(command);
      return result.events;
    } catch (error) {
      console.error('Error getting logs:', error);
      throw error;
    }
  }
}

module.exports = AWSService; 