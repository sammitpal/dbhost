#!/usr/bin/env node

/**
 * Simple API Test Script for DBHost SaaS Platform
 * 
 * This script tests the basic functionality of the Database-as-a-Service API
 * Users only need to provide database preferences - no AWS knowledge required
 * Make sure to start the server before running this script
 */

const https = require('https');
const http = require('http');

// Configuration
const API_BASE = 'http://localhost:3000/api';
const TEST_USER = {
  username: 'testuser',
  email: 'test@example.com',
  password: 'TestPass123!'
};

// Helper function to make HTTP requests
function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'https:' ? https : http;
    
    const req = protocol.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = {
            statusCode: res.statusCode,
            headers: res.headers,
            body: body ? JSON.parse(body) : null
          };
          resolve(response);
        } catch (error) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: body
          });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

// Test functions
async function testHealthCheck() {
  console.log('🔍 Testing health check...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/health',
    method: 'GET'
  };

  try {
    const response = await makeRequest(options);
    
    if (response.statusCode === 200) {
      console.log('✅ Health check passed');
      console.log('   Server uptime:', response.body.uptime, 'seconds');
      return true;
    } else {
      console.log('❌ Health check failed:', response.statusCode);
      return false;
    }
  } catch (error) {
    console.log('❌ Health check error:', error.message);
    return false;
  }
}

async function testUserRegistration() {
  console.log('🔍 Testing user registration...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await makeRequest(options, TEST_USER);
    
    if (response.statusCode === 201 || response.statusCode === 409) {
      console.log('✅ User registration test passed');
      if (response.statusCode === 409) {
        console.log('   User already exists (expected for repeated tests)');
      }
      return response.body?.token || null;
    } else {
      console.log('❌ User registration failed:', response.statusCode);
      console.log('   Response:', response.body);
      return null;
    }
  } catch (error) {
    console.log('❌ User registration error:', error.message);
    return null;
  }
}

async function testUserLogin() {
  console.log('🔍 Testing user login...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const loginData = {
    email: TEST_USER.email,
    password: TEST_USER.password
  };

  try {
    const response = await makeRequest(options, loginData);
    
    if (response.statusCode === 200) {
      console.log('✅ User login test passed');
      console.log('   Username:', response.body.user.username);
      return response.body.token;
    } else {
      console.log('❌ User login failed:', response.statusCode);
      console.log('   Response:', response.body);
      return null;
    }
  } catch (error) {
    console.log('❌ User login error:', error.message);
    return null;
  }
}

async function testGetProfile(token) {
  console.log('🔍 Testing get profile...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/profile',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  try {
    const response = await makeRequest(options);
    
    if (response.statusCode === 200) {
      console.log('✅ Get profile test passed');
      console.log('   User ID:', response.body.user._id);
      console.log('   Username:', response.body.user.username);
      return true;
    } else {
      console.log('❌ Get profile failed:', response.statusCode);
      console.log('   Response:', response.body);
      return false;
    }
  } catch (error) {
    console.log('❌ Get profile error:', error.message);
    return false;
  }
}

async function testListInstances(token) {
  console.log('🔍 Testing list instances...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/ec2/list',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  try {
    const response = await makeRequest(options);
    
    if (response.statusCode === 200) {
      console.log('✅ List instances test passed');
      console.log('   Total instances:', response.body.total);
      return true;
    } else {
      console.log('❌ List instances failed:', response.statusCode);
      console.log('   Response:', response.body);
      return false;
    }
  } catch (error) {
    console.log('❌ List instances error:', error.message);
    return false;
  }
}

async function testInvalidEndpoint() {
  console.log('🔍 Testing invalid endpoint...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/nonexistent',
    method: 'GET'
  };

  try {
    const response = await makeRequest(options);
    
    if (response.statusCode === 404) {
      console.log('✅ Invalid endpoint test passed (404 as expected)');
      return true;
    } else {
      console.log('❌ Invalid endpoint test failed:', response.statusCode);
      return false;
    }
  } catch (error) {
    console.log('❌ Invalid endpoint error:', error.message);
    return false;
  }
}

async function testUnauthorizedAccess() {
  console.log('🔍 Testing unauthorized access...');
  
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/ec2/list',
    method: 'GET'
  };

  try {
    const response = await makeRequest(options);
    
    if (response.statusCode === 401) {
      console.log('✅ Unauthorized access test passed (401 as expected)');
      return true;
    } else {
      console.log('❌ Unauthorized access test failed:', response.statusCode);
      return false;
    }
  } catch (error) {
    console.log('❌ Unauthorized access error:', error.message);
    return false;
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting DBHost API Tests\n');
  
  const results = [];
  
  // Test 1: Health Check
  results.push(await testHealthCheck());
  console.log('');
  
  // Test 2: Invalid Endpoint
  results.push(await testInvalidEndpoint());
  console.log('');
  
  // Test 3: Unauthorized Access
  results.push(await testUnauthorizedAccess());
  console.log('');
  
  // Test 4: User Registration
  const registrationToken = await testUserRegistration();
  results.push(!!registrationToken);
  console.log('');
  
  // Test 5: User Login
  const loginToken = await testUserLogin();
  results.push(!!loginToken);
  console.log('');
  
  const token = loginToken || registrationToken;
  
  if (token) {
    // Test 6: Get Profile
    results.push(await testGetProfile(token));
    console.log('');
    
    // Test 7: List Instances
    results.push(await testListInstances(token));
    console.log('');
  } else {
    console.log('⚠️  Skipping authenticated tests due to authentication failure\n');
    results.push(false, false);
  }
  
  // Summary
  const passed = results.filter(Boolean).length;
  const total = results.length;
  
  console.log('📊 Test Results Summary');
  console.log('='.repeat(50));
  console.log(`✅ Passed: ${passed}/${total}`);
  console.log(`❌ Failed: ${total - passed}/${total}`);
  
  if (passed === total) {
    console.log('\n🎉 All tests passed! The API is working correctly.');
  } else {
    console.log('\n⚠️  Some tests failed. Please check the server logs and configuration.');
  }
  
  console.log('\n💡 Next steps:');
  console.log('   1. Configure your AWS credentials in .env');
  console.log('   2. Set up VPC, Subnet, and Key Pair in AWS');
  console.log('   3. Test EC2 instance creation with proper AWS setup');
  console.log('   4. Try the WebSocket log streaming functionality');
}

// Check if server is running
async function checkServer() {
  try {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/health',
      method: 'GET',
      timeout: 5000
    };
    
    await makeRequest(options);
    return true;
  } catch (error) {
    return false;
  }
}

// Entry point
async function main() {
  console.log('DBHost API Test Suite');
  console.log('====================\n');
  
  // Check if server is running
  const serverRunning = await checkServer();
  
  if (!serverRunning) {
    console.log('❌ Server is not running on localhost:3000');
    console.log('   Please start the server with: npm start or npm run dev');
    process.exit(1);
  }
  
  await runTests();
}

// Run the tests
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  makeRequest,
  testHealthCheck,
  testUserRegistration,
  testUserLogin,
  runTests
}; 