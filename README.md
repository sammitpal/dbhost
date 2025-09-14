# DBHost - Database-as-a-Service API

A comprehensive SaaS platform for instantly deploying managed PostgreSQL and MySQL databases on AWS EC2 instances. Users can create, manage, and scale database instances without any AWS knowledge or infrastructure setup.

## Features

- 🚀 **Instant Database Deployment** - Create PostgreSQL/MySQL instances in seconds
- 🔐 **Secure Multi-tenant Platform** with JWT authentication
- 🗄️ **Multiple Database Engines** (PostgreSQL & MySQL)
- 👥 **Database User Management** with granular privilege control
- 🔄 **Full Instance Lifecycle Control** (start/stop/terminate)
- 📊 **Real-time Log Monitoring** via WebSocket streaming
- 📈 **Instance Health Monitoring** and status tracking
- 🔒 **Automatic Security Configuration** - no AWS knowledge required
- 🌏 **Optimized for India** (ap-south-1 Mumbai region)
- 💰 **Cost-effective SaaS Model** - shared infrastructure, individual databases
- 🛡️ **Zero Infrastructure Setup** - fully managed service

## Prerequisites (For Service Providers)

- Node.js 16+ and npm
- MongoDB database
- AWS Account with appropriate permissions (service owner)
- AWS access keys configured in environment
- Pre-configured infrastructure in ap-south-1:
  - VPC and Subnet
  - EC2 Key Pair for instance access
  - Appropriate IAM roles and permissions

**Note**: End users don't need any AWS knowledge or setup - this is handled by the service provider.

## Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd dbhost
```

2. **Install dependencies**
```bash
npm install
```

3. **Environment Configuration**
Copy `env.example` to `.env` and configure:
```bash
cp env.example .env
```

Edit `.env` with your configuration:
```env
# Server Configuration
PORT=3000
NODE_ENV=development

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/dbhost

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=7d

# AWS Configuration (Service Owner Account - ap-south-1 region)
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-service-owner-aws-access-key
AWS_SECRET_ACCESS_KEY=your-service-owner-aws-secret-key

# Pre-configured Infrastructure (Service Owner Setup)
VPC_ID=vpc-005af82920c06330f
SUBNET_ID=subnet-08aaa81c09be87ebf
KEY_PAIR_NAME=dbhost-service-keypair

# Database Configuration
DEFAULT_DB_USERNAME=dbadmin
DEFAULT_DB_PASSWORD=SecurePassword123!
```

4. **Start the server**
```bash
# Development
npm run dev

# Production
npm start
```

5. **Import Postman Collection (Optional)**
```bash
# Import the provided Postman collection for easy API testing
# File: DBHost-API.postman_collection.json
```

## API Documentation

**Simple SaaS API**: Users only need to provide database preferences (name, type, credentials). All AWS infrastructure is automatically managed.

### 📋 Postman Collection

A complete Postman collection is provided: `DBHost-API.postman_collection.json`

**Features:**
- ✅ All API endpoints with examples
- ✅ Automatic JWT token management
- ✅ Environment variables setup
- ✅ Auto-save instance IDs for testing
- ✅ Comprehensive descriptions and test scripts

**Setup:**
1. Import `DBHost-API.postman_collection.json` into Postman
2. Set environment variable `baseUrl` to `http://localhost:3000`
3. Start with Authentication → Register/Login
4. JWT tokens and instance IDs are automatically saved for subsequent requests

### Authentication Endpoints

#### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "johndoe",
    "email": "john@example.com",
    "password": "SecurePass123!"
  }'
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "SecurePass123!"
  }'
```

#### Get Profile
```http
GET /api/auth/profile
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### EC2 Instance Management

#### Create Database Instance
```http
POST /api/ec2/create
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "name": "my-database-server",
  "databaseType": "postgresql",
  "databaseVersion": "13",
  "instanceType": "t3.micro",
  "masterUsername": "dbadmin",
  "masterPassword": "SecureDBPass123!"
}
```

**User Provides**: Database name, type, version, size, and master credentials  
**Automatically Handled**: AWS infrastructure, networking, security groups, region selection

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/ec2/create \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-database-server",
    "databaseType": "postgresql",
    "databaseVersion": "13",
    "instanceType": "t3.micro",
    "masterUsername": "dbadmin",
    "masterPassword": "SecureDBPass123!"
  }'
```

#### List User's Instances
```http
GET /api/ec2/list?status=running&databaseType=postgresql
Authorization: Bearer <jwt-token>
```

**cURL Examples:**
```bash
# List all instances
curl -X GET http://localhost:3000/api/ec2/list \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# List running PostgreSQL instances
curl -X GET "http://localhost:3000/api/ec2/list?status=running&databaseType=postgresql" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get Instance Details
```http
GET /api/ec2/{instanceId}
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/ec2/i-1234567890abcdef0 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Start Instance
```http
POST /api/ec2/{instanceId}/start
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/ec2/i-1234567890abcdef0/start \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Stop Instance
```http
POST /api/ec2/{instanceId}/stop
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/ec2/i-1234567890abcdef0/stop \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Terminate Instance
```http
DELETE /api/ec2/{instanceId}
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X DELETE http://localhost:3000/api/ec2/i-1234567890abcdef0 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Update Network Configuration
```http
PUT /api/ec2/{instanceId}/network
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "ports": [
    {
      "port": 8080,
      "protocol": "tcp",
      "description": "Custom application port"
    }
  ]
}
```

**cURL Example:**
```bash
curl -X PUT http://localhost:3000/api/ec2/i-1234567890abcdef0/network \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ports": [
      {
        "port": 8080,
        "protocol": "tcp",
        "description": "Custom application port"
      }
    ]
  }'
```

### Database User Management

#### Create Database User
```http
POST /api/database/{instanceId}/users
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "username": "appuser",
  "password": "UserPass123!",
  "privileges": ["SELECT", "INSERT", "UPDATE", "DELETE"]
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/database/i-1234567890abcdef0/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "appuser",
    "password": "UserPass123!",
    "privileges": ["SELECT", "INSERT", "UPDATE", "DELETE"]
  }'
```

#### List Database Users
```http
GET /api/database/{instanceId}/users
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/database/i-1234567890abcdef0/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Update User Privileges
```http
PUT /api/database/{instanceId}/users/{username}
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "privileges": ["SELECT", "INSERT"],
  "password": "NewPassword123!"
}
```

**cURL Example:**
```bash
curl -X PUT http://localhost:3000/api/database/i-1234567890abcdef0/users/appuser \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "privileges": ["SELECT", "INSERT"],
    "password": "NewPassword123!"
  }'
```

#### Delete Database User
```http
DELETE /api/database/{instanceId}/users/{username}
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X DELETE http://localhost:3000/api/database/i-1234567890abcdef0/users/appuser \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get Connection Information
```http
GET /api/database/{instanceId}/connection
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/database/i-1234567890abcdef0/connection \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Execute Custom Database Command
```http
POST /api/database/{instanceId}/execute
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "command": "SELECT version();",
  "database": "postgres"
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/database/i-1234567890abcdef0/execute \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "SELECT version();",
    "database": "postgres"
  }'
```

### Log Management

#### Get Instance Logs
```http
GET /api/logs/{instanceId}?startTime=2023-01-01T00:00:00Z&limit=100
Authorization: Bearer <jwt-token>
```

**cURL Examples:**
```bash
# Get recent logs
curl -X GET http://localhost:3000/api/logs/i-1234567890abcdef0 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get logs with time filter
curl -X GET "http://localhost:3000/api/logs/i-1234567890abcdef0?startTime=2023-01-01T00:00:00Z&limit=100" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get Command Execution Result
```http
GET /api/logs/{instanceId}/command/{commandId}
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/logs/i-1234567890abcdef0/command/12345678-1234-1234-1234-123456789012 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Start Real-time Log Streaming
```http
GET /api/logs/{instanceId}/stream
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/logs/i-1234567890abcdef0/stream \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get Database Logs
```http
GET /api/logs/{instanceId}/database?lines=100
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET "http://localhost:3000/api/logs/i-1234567890abcdef0/database?lines=100" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Get System Logs
```http
GET /api/logs/{instanceId}/system?lines=50
Authorization: Bearer <jwt-token>
```

**cURL Example:**
```bash
curl -X GET "http://localhost:3000/api/logs/i-1234567890abcdef0/system?lines=50" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Complete cURL Workflow Example

Here's a complete workflow using cURL commands:

### 1. Register and Login
```bash
# Register a new user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "developer",
    "email": "dev@company.com",
    "password": "SecurePass123!"
  }'

# Login to get JWT token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dev@company.com",
    "password": "SecurePass123!"
  }' | jq -r '.token')

echo "JWT Token: $TOKEN"
```

### 2. Create and Manage EC2 Instance
```bash
# Create PostgreSQL instance
INSTANCE_RESPONSE=$(curl -s -X POST http://localhost:3000/api/ec2/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-postgres",
    "databaseType": "postgresql",
    "databaseVersion": "13",
    "instanceType": "t3.micro",
    "masterUsername": "postgres_admin",
    "masterPassword": "SecureDBPass123!"
  }')

INSTANCE_ID=$(echo $INSTANCE_RESPONSE | jq -r '.instance.instanceId')
echo "Created Instance: $INSTANCE_ID"

# Check instance status
curl -X GET http://localhost:3000/api/ec2/$INSTANCE_ID \
  -H "Authorization: Bearer $TOKEN"

# List all instances
curl -X GET http://localhost:3000/api/ec2/list \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Database User Management
```bash
# Wait for instance to be running, then create database user
curl -X POST http://localhost:3000/api/database/$INSTANCE_ID/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "app_user",
    "password": "AppUserPass123!",
    "privileges": ["SELECT", "INSERT", "UPDATE", "DELETE"]
  }'

# Get connection information
curl -X GET http://localhost:3000/api/database/$INSTANCE_ID/connection \
  -H "Authorization: Bearer $TOKEN"

# List database users
curl -X GET http://localhost:3000/api/database/$INSTANCE_ID/users \
  -H "Authorization: Bearer $TOKEN"
```

### 4. Log Management
```bash
# Get system logs
curl -X GET http://localhost:3000/api/logs/$INSTANCE_ID/system \
  -H "Authorization: Bearer $TOKEN"

# Get database logs
curl -X GET http://localhost:3000/api/logs/$INSTANCE_ID/database \
  -H "Authorization: Bearer $TOKEN"

# Execute custom database command
curl -X POST http://localhost:3000/api/database/$INSTANCE_ID/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "SELECT version();"
  }'
```

### 5. Instance Control
```bash
# Stop instance
curl -X POST http://localhost:3000/api/ec2/$INSTANCE_ID/stop \
  -H "Authorization: Bearer $TOKEN"

# Start instance
curl -X POST http://localhost:3000/api/ec2/$INSTANCE_ID/start \
  -H "Authorization: Bearer $TOKEN"

# Terminate instance (careful!)
curl -X DELETE http://localhost:3000/api/ec2/$INSTANCE_ID \
  -H "Authorization: Bearer $TOKEN"
```

## WebSocket Real-time Logs

Connect to WebSocket for real-time log streaming:

```javascript
const ws = new WebSocket('ws://localhost:3000');

ws.onmessage = function(event) {
  const data = JSON.parse(event.data);
  if (data.type === 'logs') {
    console.log('New logs for instance:', data.instanceId);
    console.log('Logs:', data.logs);
  }
};

// Start streaming for an instance
fetch('/api/logs/i-1234567890abcdef0/stream', {
  headers: {
    'Authorization': 'Bearer ' + token
  }
});
```

## Usage Examples

### 1. Complete Workflow Example

```javascript
// 1. Register and login
const registerResponse = await fetch('/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'developer',
    email: 'dev@company.com',
    password: 'SecurePass123!'
  })
});

const { token } = await registerResponse.json();

// 2. Create PostgreSQL instance
const createResponse = await fetch('/api/ec2/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    name: 'production-postgres',
    databaseType: 'postgresql',
    databaseVersion: '13',
    instanceType: 't3.small',
    masterUsername: 'postgres_admin',
    masterPassword: 'SecureDBPass123!'
  })
});

const { instance } = await createResponse.json();
console.log('Instance created:', instance.instanceId);

// 3. Wait for instance to be running (poll status)
let instanceRunning = false;
while (!instanceRunning) {
  const statusResponse = await fetch(`/api/ec2/${instance.instanceId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const { instance: currentInstance } = await statusResponse.json();
  
  if (currentInstance.status === 'running') {
    instanceRunning = true;
    console.log('Instance is running!');
    console.log('Connection string:', currentInstance.connectionString);
  } else {
    console.log('Instance status:', currentInstance.status);
    await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
  }
}

// 4. Create application database user
const userResponse = await fetch(`/api/database/${instance.instanceId}/users`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    username: 'app_user',
    password: 'AppUserPass123!',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  })
});

console.log('Database user created');

// 5. Get connection information
const connectionResponse = await fetch(`/api/database/${instance.instanceId}/connection`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

const { connectionInfo } = await connectionResponse.json();
console.log('Database connection info:', connectionInfo);
```

### 2. Database Connection Examples

#### PostgreSQL Connection
```javascript
const { Client } = require('pg');

const client = new Client({
  host: connectionInfo.host,
  port: connectionInfo.port,
  database: 'postgres',
  user: 'app_user',
  password: 'AppUserPass123!',
  ssl: { rejectUnauthorized: false }
});

await client.connect();
const result = await client.query('SELECT version()');
console.log(result.rows[0]);
await client.end();
```

#### MySQL Connection
```javascript
const mysql = require('mysql2/promise');

const connection = await mysql.createConnection({
  host: connectionInfo.host,
  port: connectionInfo.port,
  user: 'app_user',
  password: 'AppUserPass123!',
  ssl: { rejectUnauthorized: false }
});

const [rows] = await connection.execute('SELECT VERSION()');
console.log(rows[0]);
await connection.end();
```

## AWS Permissions Required

Your AWS user/role needs the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:DescribeSecurityGroups",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:DescribeInstanceInformation"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

## Security Considerations

1. **Environment Variables**: Never commit `.env` file to version control
2. **JWT Secret**: Use a strong, unique JWT secret in production
3. **Database Passwords**: Use strong passwords with mixed characters
4. **AWS Credentials**: Use IAM roles when possible instead of access keys
5. **Network Security**: Configure security groups with minimal required access
6. **HTTPS**: Use HTTPS in production environments
7. **Rate Limiting**: API includes rate limiting to prevent abuse

## Monitoring and Logging

The application provides comprehensive logging:

- **Application logs**: Server startup, errors, API requests
- **Database installation logs**: Available via `/var/log/dbhost/install.log`
- **System logs**: Standard Linux system logs
- **Database logs**: PostgreSQL/MySQL specific logs
- **Real-time streaming**: WebSocket-based log streaming

## Troubleshooting

### Common Issues

1. **Instance fails to start**
   - Check AWS credentials and permissions
   - Verify VPC and subnet configuration
   - Ensure key pair exists in the specified region

2. **Database installation fails**
   - Check instance logs via `/api/logs/{instanceId}/system`
   - Verify user data script execution
   - Check security group configuration

3. **Cannot connect to database**
   - Ensure instance is in 'running' state
   - Verify security group allows database port
   - Check database service status in logs

4. **SSM commands fail**
   - Ensure EC2 instance has SSM agent installed
   - Verify IAM role for EC2 includes SSM permissions
   - Check instance is registered with SSM

### Getting Help

1. Check application logs in the console
2. Use the `/api/logs/{instanceId}/system` endpoint for instance logs
3. Monitor CloudWatch logs if configured
4. Check AWS CloudTrail for API call issues

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details. 