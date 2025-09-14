const {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
} = require('@aws-sdk/client-ec2');
const {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
  DescribeInstanceInformationCommand,
} = require('@aws-sdk/client-ssm');
const {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} = require('@aws-sdk/client-cloudwatch-logs');

class AWSService {
  constructor(accessKeyId, secretAccessKey, region = 'ap-south-1') {
    this.region = region;
    this.ec2Client = new EC2Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.ssmClient = new SSMClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.logsClient = new CloudWatchLogsClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /**
   * Generate EC2 user-data script
   * databaseType: 'postgresql' | 'mysql'
   */
  generateUserData(databaseType, databaseVersion, masterUsername, masterPassword, databasePort) {
    const baseScript = `#!/bin/bash
set -e
mkdir -p /var/log/dbhost
echo "$(date): Starting instance setup" >> /var/log/dbhost/install.log
`;

    // -----------------------------
    // Install SSM Agent for Ubuntu 24.04
    // -----------------------------
    const ssmScript = `
echo "$(date): Installing Amazon SSM Agent" >> /var/log/dbhost/install.log
snap install amazon-ssm-agent --classic
systemctl enable snap.amazon-ssm-agent.amazon-ssm-agent.service
systemctl start snap.amazon-ssm-agent.amazon-ssm-agent.service
echo "$(date): SSM Agent installed" >> /var/log/dbhost/install.log
`;

    if (databaseType === 'postgresql') {
      return baseScript + ssmScript + `
echo "$(date): Installing PostgreSQL" >> /var/log/dbhost/install.log
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib

systemctl enable postgresql
systemctl start postgresql

# Set postgres password
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '${masterPassword}';"

# Create application user
sudo -u postgres createuser --createdb ${masterUsername} || true
sudo -u postgres psql -c "ALTER USER ${masterUsername} PASSWORD '${masterPassword}';"

# Allow remote connections
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/*/main/postgresql.conf
echo "host all all 0.0.0.0/0 md5" >> /etc/postgresql/*/main/pg_hba.conf
sed -i "s/^port = 5432/port = ${databasePort}/" /etc/postgresql/*/main/postgresql.conf

systemctl restart postgresql
echo "$(date): PostgreSQL installation completed" >> /var/log/dbhost/install.log
`;
    }

    if (databaseType === 'mysql') {
      return baseScript + ssmScript + `
echo "$(date): Installing MySQL" >> /var/log/dbhost/install.log
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server

systemctl enable mysql
systemctl start mysql

# Set root password and create application user
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${masterPassword}';"
mysql -u root -p${masterPassword} -e "CREATE USER '${masterUsername}'@'%' IDENTIFIED BY '${masterPassword}';"
mysql -u root -p${masterPassword} -e "GRANT ALL PRIVILEGES ON *.* TO '${masterUsername}'@'%' WITH GRANT OPTION;"
mysql -u root -p${masterPassword} -e "FLUSH PRIVILEGES;"

# Configure MySQL for remote connections
sed -i "s/bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/mysql.conf.d/mysqld.cnf
sed -i "s/port.*/port = ${databasePort}/" /etc/mysql/mysql.conf.d/mysqld.cnf

systemctl restart mysql
echo "$(date): MySQL installation completed" >> /var/log/dbhost/install.log
`;
    }

    throw new Error(`Unsupported database type: ${databaseType}`);
  }

  async createSecurityGroup(vpcId, databaseType, databasePort) {
    const groupName = `dbhost-${databaseType}-${Date.now()}`;
    const createSgCommand = new CreateSecurityGroupCommand({
      GroupName: groupName,
      Description: `Security group for ${databaseType} database`,
      VpcId: vpcId,
    });
    const sgResult = await this.ec2Client.send(createSgCommand);
    const securityGroupId = sgResult.GroupId;

    const rules = [
      {
        IpProtocol: 'tcp', FromPort: 22, ToPort: 22,
        IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SSH access' }]
      },
      {
        IpProtocol: 'tcp', FromPort: databasePort, ToPort: databasePort,
        IpRanges: [{ CidrIp: '0.0.0.0/0', Description: `${databaseType} access` }]
      },
    ];

    await this.ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: rules,
      })
    );
    return securityGroupId;
  }

  async launchInstance(params) {
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
      masterPassword,
    } = params;

    const securityGroupId = await this.createSecurityGroup(
      vpcId,
      databaseType,
      databasePort
    );

    const userData = this.generateUserData(
      databaseType,
      databaseVersion,
      masterUsername,
      masterPassword,
      databasePort
    );

    const runCommand = new RunInstancesCommand({
      ImageId: 'ami-02d26659fd82cf299', // Ubuntu 24.04 AMI
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
            { Key: 'ManagedBy', Value: 'DBHost' },
          ],
        },
      ],
    });

    const result = await this.ec2Client.send(runCommand);
    return {
      instanceId: result.Instances[0].InstanceId,
      securityGroupId,
      userData,
    };
  }

  async getInstanceDetails(instanceIds) {
    const command = new DescribeInstancesCommand({
      InstanceIds: Array.isArray(instanceIds) ? instanceIds : [instanceIds],
    });
    const result = await this.ec2Client.send(command);
    const instances = [];
    result.Reservations.forEach(r =>
      r.Instances.forEach(i =>
        instances.push({
          instanceId: i.InstanceId,
          state: i.State.Name,
          instanceType: i.InstanceType,
          publicIpAddress: i.PublicIpAddress,
          privateIpAddress: i.PrivateIpAddress,
          launchTime: i.LaunchTime,
          vpcId: i.VpcId,
          subnetId: i.SubnetId,
          securityGroups: i.SecurityGroups,
          tags: i.Tags || [],
        })
      )
    );
    return instances;
  }

  async startInstance(id) {
    return (
      await this.ec2Client.send(new StartInstancesCommand({ InstanceIds: [id] }))
    ).StartingInstances[0];
  }

  async stopInstance(id) {
    return (
      await this.ec2Client.send(new StopInstancesCommand({ InstanceIds: [id] }))
    ).StoppingInstances[0];
  }

  async terminateInstance(id) {
    return (
      await this.ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [id] }))
    ).TerminatingInstances[0];
  }

  // -----------------------------
  // Wait until SSM agent is ready
  // -----------------------------
  async waitForSsmInstance(instanceId, maxAttempts = 20, delayMs = 15000) {
    let attempt = 0;
    while (attempt < maxAttempts) {
      const resp = await this.ssmClient.send(new DescribeInstanceInformationCommand({}));
      const found = resp.InstanceInformationList.some(info => info.InstanceId === instanceId);
      if (found) return true;
      attempt++;
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error(`SSM agent not ready on instance ${instanceId} after ${maxAttempts} attempts`);
  }

  async executeCommand(instanceId, commands) {
    await this.waitForSsmInstance(instanceId);

    const cmd = new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: Array.isArray(commands) ? commands : [commands] },
      TimeoutSeconds: 120, // 5 minute timeout
      Comment: `DBHost command execution - ${new Date().toISOString()}`
    });

    const result = await this.ssmClient.send(cmd);
    console.log(`SSM Command initiated: ${result.Command.CommandId} for instance ${instanceId}`);
    return result.Command;
  }

  async getCommandResult(commandId, instanceId) {
    try {
      const result = await this.ssmClient.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      
      // Add status information
      const status = result.Status;
      const isComplete = ['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(status);
      
      return {
        ...result,
        IsComplete: isComplete,
        StatusMessage: this.getStatusMessage(status)
      };
    } catch (error) {
      console.error('Error getting command result:', error);
      throw error;
    }
  }

  getStatusMessage(status) {
    const statusMessages = {
      'Pending': 'Command is queued for execution',
      'InProgress': 'Command is currently executing',
      'Success': 'Command completed successfully',
      'Failed': 'Command execution failed',
      'Cancelled': 'Command was cancelled',
      'TimedOut': 'Command execution timed out',
      'Cancelling': 'Command is being cancelled'
    };
    return statusMessages[status] || `Unknown status: ${status}`;
  }

  async getLogs(logGroupName, logStreamName, startTime, endTime) {
    return (
      await this.logsClient.send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          startTime,
          endTime,
          limit: 100,
        })
      )
    ).events;
  }
}

module.exports = AWSService;
