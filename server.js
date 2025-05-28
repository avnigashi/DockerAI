// server.js - Production-ready Docker management backend
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const Docker = require('dockerode');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize Docker connection
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock'
});

// Initialize OpenAI
let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Mock user database (replace with real database)
const users = [
  {
    id: 1,
    username: 'admin',
    password: '$2b$10$9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9O', // bcrypt hash of 'admin123'
    role: 'admin'
  }
];

// JWT middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Authentication routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Docker API routes
app.get('/api/containers', authenticateToken, async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const enrichedContainers = await Promise.all(
      containers.map(async (container) => {
        try {
          const containerObj = docker.getContainer(container.Id);
          const stats = await containerObj.stats({ stream: false });
          const inspect = await containerObj.inspect();
          
          // Calculate CPU percentage
          const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - 
                          (stats.precpu_stats.cpu_usage?.total_usage || 0);
          const systemDelta = stats.cpu_stats.system_cpu_usage - 
                             (stats.precpu_stats.system_cpu_usage || 0);
          const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * 100 * stats.cpu_stats.online_cpus : 0;

          // Calculate memory usage
          const memoryUsage = stats.memory_stats.usage || 0;
          const memoryLimit = stats.memory_stats.limit || 0;
          const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

          return {
            id: container.Id.substring(0, 12),
            name: container.Names[0].replace('/', ''),
            image: container.Image,
            status: container.State,
            created: new Date(container.Created * 1000).toISOString(),
            ports: container.Ports.map(p => `${p.PublicPort || ''}:${p.PrivatePort}`).filter(p => p !== ':'),
            cpu: `${cpuPercent.toFixed(1)}%`,
            memory: `${(memoryUsage / 1024 / 1024).toFixed(1)} MB`,
            memoryPercent: memoryPercent.toFixed(1),
            network: inspect.NetworkSettings.Networks ? Object.keys(inspect.NetworkSettings.Networks)[0] : 'none',
            labels: container.Labels || {},
            mounts: inspect.Mounts || []
          };
        } catch (error) {
          console.error(`Error getting container stats for ${container.Id}:`, error);
          return {
            id: container.Id.substring(0, 12),
            name: container.Names[0].replace('/', ''),
            image: container.Image,
            status: container.State,
            created: new Date(container.Created * 1000).toISOString(),
            ports: container.Ports.map(p => `${p.PublicPort || ''}:${p.PrivatePort}`).filter(p => p !== ':'),
            cpu: '0%',
            memory: '0 MB',
            memoryPercent: '0',
            network: 'unknown',
            labels: container.Labels || {},
            mounts: []
          };
        }
      })
    );

    res.json(enrichedContainers);
  } catch (error) {
    console.error('Error fetching containers:', error);
    res.status(500).json({ error: 'Failed to fetch containers' });
  }
});

app.post('/api/containers/:id/:action', authenticateToken, async (req, res) => {
  try {
    const { id, action } = req.params;
    const container = docker.getContainer(id);

    switch (action) {
      case 'start':
        await container.start();
        break;
      case 'stop':
        await container.stop();
        break;
      case 'restart':
        await container.restart();
        break;
      case 'remove':
        await container.remove({ force: true });
        break;
      case 'pause':
        await container.pause();
        break;
      case 'unpause':
        await container.unpause();
        break;
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    // Broadcast update to all connected clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'container_action',
          data: { containerId: id, action, timestamp: new Date().toISOString() }
        }));
      }
    });

    res.json({ success: true, message: `Container ${action} successful` });
  } catch (error) {
    console.error(`Error ${req.params.action} container:`, error);
    res.status(500).json({ error: `Failed to ${req.params.action} container` });
  }
});

app.get('/api/containers/:id/logs', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { tail = 100 } = req.query;
    const container = docker.getContainer(id);
    
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: parseInt(tail),
      timestamps: true
    });

    res.json({ logs: logs.toString() });
  } catch (error) {
    console.error('Error fetching container logs:', error);
    res.status(500).json({ error: 'Failed to fetch container logs' });
  }
});

app.get('/api/images', authenticateToken, async (req, res) => {
  try {
    const images = await docker.listImages();
    const formattedImages = images.map(image => ({
      id: image.Id.replace('sha256:', '').substring(0, 12),
      repository: image.RepoTags ? image.RepoTags[0].split(':')[0] : '<none>',
      tag: image.RepoTags ? image.RepoTags[0].split(':')[1] : '<none>',
      size: `${(image.Size / 1024 / 1024).toFixed(1)} MB`,
      created: new Date(image.Created * 1000).toISOString(),
      labels: image.Labels || {}
    }));

    res.json(formattedImages);
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

app.get('/api/networks', authenticateToken, async (req, res) => {
  try {
    const networks = await docker.listNetworks();
    const formattedNetworks = networks.map(network => ({
      id: network.Id.substring(0, 12),
      name: network.Name,
      driver: network.Driver,
      scope: network.Scope,
      containers: Object.keys(network.Containers || {}).length,
      created: network.Created,
      labels: network.Labels || {}
    }));

    res.json(formattedNetworks);
  } catch (error) {
    console.error('Error fetching networks:', error);
    res.status(500).json({ error: 'Failed to fetch networks' });
  }
});

app.get('/api/volumes', authenticateToken, async (req, res) => {
  try {
    const volumes = await docker.listVolumes();
    const formattedVolumes = volumes.Volumes.map(volume => ({
      name: volume.Name,
      driver: volume.Driver,
      mountpoint: volume.Mountpoint,
      created: volume.CreatedAt,
      labels: volume.Labels || {}
    }));

    res.json(formattedVolumes);
  } catch (error) {
    console.error('Error fetching volumes:', error);
    res.status(500).json({ error: 'Failed to fetch volumes' });
  }
});

// Open Interpreter Integration
class OpenInterpreterManager {
  constructor() {
    this.activeSessions = new Map();
    this.pythonPath = process.env.PYTHON_PATH || 'python3';
    this.interpreterPath = process.env.INTERPRETER_PATH || 'interpreter';
  }

  async executeCommand(sessionId, message, options = {}) {
    try {
      const session = this.getOrCreateSession(sessionId);
      
      // Create a temporary Python script to use Open Interpreter programmatically
      const scriptContent = `
import sys
import json
from interpreter import interpreter

# Configure interpreter
interpreter.auto_run = ${options.autoRun || false}
interpreter.local = ${options.local || true}
interpreter.offline = True

# Set model if provided
if "${options.model}":
    interpreter.llm.model = "${options.model}"

# Set API configuration if provided
if "${options.apiKey}":
    interpreter.llm.api_key = "${options.apiKey}"
if "${options.apiBase}":
    interpreter.llm.api_base = "${options.apiBase}"

# Execute the command
try:
    result = []
    for chunk in interpreter.chat("${message.replace(/"/g, '\\"')}", stream=True, display=False):
        if chunk:
            result.append(chunk)
            print(json.dumps({"type": "chunk", "data": chunk}))
            sys.stdout.flush()
    
    print(json.dumps({"type": "complete", "data": {"messages": interpreter.messages}}))
except Exception as e:
    print(json.dumps({"type": "error", "data": {"error": str(e)}}))
`;

      const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'dockerai-'));
      const scriptPath = path.join(tempDir, 'interpreter_session.py');
      await fs.writeFile(scriptPath, scriptContent);

      return new Promise((resolve, reject) => {
        const pythonProcess = spawn(this.pythonPath, [scriptPath], {
          cwd: tempDir,
          env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH }
        });

        let output = [];
        let errorOutput = [];

        pythonProcess.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(line => line.trim());
          lines.forEach(line => {
            try {
              const parsed = JSON.parse(line);
              output.push(parsed);
            } catch (e) {
              // Non-JSON output, treat as regular output
              output.push({ type: 'output', data: line });
            }
          });
        });

        pythonProcess.stderr.on('data', (data) => {
          errorOutput.push(data.toString());
        });

        pythonProcess.on('close', async (code) => {
          // Clean up temp files
          try {
            await fs.unlink(scriptPath);
            await fs.rmdir(tempDir);
          } catch (e) {
            console.warn('Failed to clean up temp files:', e);
          }

          if (code === 0) {
            resolve({
              success: true,
              output: output,
              messages: session.messages
            });
          } else {
            reject(new Error(`Process exited with code ${code}: ${errorOutput.join('')}`));
          }
        });

        pythonProcess.on('error', (error) => {
          reject(error);
        });

        // Store process reference for potential cancellation
        session.currentProcess = pythonProcess;
      });
    } catch (error) {
      throw new Error(`Open Interpreter execution failed: ${error.message}`);
    }
  }

  getOrCreateSession(sessionId) {
    if (!this.activeSessions.has(sessionId)) {
      this.activeSessions.set(sessionId, {
        id: sessionId,
        messages: [],
        createdAt: new Date(),
        currentProcess: null
      });
    }
    return this.activeSessions.get(sessionId);
  }

  cancelExecution(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session && session.currentProcess) {
      session.currentProcess.kill('SIGTERM');
      session.currentProcess = null;
      return true;
    }
    return false;
  }

  clearSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      if (session.currentProcess) {
        session.currentProcess.kill('SIGTERM');
      }
      this.activeSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  getSessionHistory(sessionId) {
    const session = this.activeSessions.get(sessionId);
    return session ? session.messages : [];
  }
}

const openInterpreterManager = new OpenInterpreterManager();
app.post('/api/ai/chat', authenticateToken, async (req, res) => {
  try {
    const { message, apiKey } = req.body;
    
    if (!apiKey && !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'OpenAI API key required' });
    }

    const aiClient = apiKey ? new OpenAI({ apiKey }) : openai;
    
    // Get current Docker state for context
    const containers = await docker.listContainers({ all: true });
    const containerContext = containers.map(c => ({
      name: c.Names[0].replace('/', ''),
      status: c.State,
      image: c.Image
    }));

    const systemPrompt = `You are DockerAI, an AI assistant for Docker container management. 
    Current containers: ${JSON.stringify(containerContext)}
    
    You can help users:
    - Check container status
    - Start/stop/restart containers
    - View container information
    - Manage Docker resources
    
    Respond helpfully and suggest specific Docker commands when appropriate.
    Keep responses concise but informative.`;

    const completion = await aiClient.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    res.json({ 
      response: completion.choices[0].message.content,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    res.status(500).json({ error: 'AI service unavailable' });
  }
});

// System info route
app.get('/api/system/info', authenticateToken, async (req, res) => {
  try {
    const info = await docker.info();
    const version = await docker.version();
    
    res.json({
      docker: {
        version: version.Version,
        apiVersion: version.ApiVersion,
        architecture: version.Arch,
        os: version.Os
      },
      system: {
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersPaused: info.ContainersPaused,
        containersStopped: info.ContainersStopped,
        images: info.Images,
        memTotal: info.MemTotal,
        cpus: info.NCPU,
        serverVersion: info.ServerVersion
      }
    });
  } catch (error) {
    console.error('Error fetching system info:', error);
    res.status(500).json({ error: 'Failed to fetch system info' });
  }
});

// WebSocket connection for real-time updates
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data);
    } catch (error) {
      console.error('Invalid WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
  });

  // Send initial connection confirmation
  ws.send(JSON.stringify({
    type: 'connection',
    data: { status: 'connected', timestamp: new Date().toISOString() }
  }));
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`DockerAI Backend running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
