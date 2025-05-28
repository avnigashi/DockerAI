# DockerAI - Production Deployment Guide

## 🚀 Overview

DockerAI is an AI-powered Docker management platform that serves as a modern alternative to Portainer. It features real-time container monitoring, natural language AI commands via OpenAI integration, and a sleek web interface.

## 📋 Prerequisites

- Node.js 16+ and npm 8+
- Python 3.8+ with pip
- Docker and Docker Compose
- Access to Docker socket (`/var/run/docker.sock`)
- OpenAI API key (optional - users can provide their own)
- Open Interpreter (`pip install open-interpreter`)
- SSL certificate for HTTPS (recommended for production)

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React Frontend │◄──►│  Node.js Backend │◄──►│   Docker Engine │
│   (Port 3000)   │    │   (Port 3001)   │    │ (Socket/API)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Static Hosting │    │   WebSocket     │    │   Container     │
│   (Nginx/CDN)   │    │   Real-time     │    │   Management    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🛠️ Installation

### Backend Setup

1. **Clone and Setup Backend**
```bash
mkdir dockerai && cd dockerai
mkdir backend && cd backend

# Copy the backend code (server.js) to this directory
# Copy package.json to this directory

npm install
```

2. **Environment Configuration**
```bash
# Copy the .env.example file and customize
cp .env.example .env

# Generate a secure JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Edit .env file with your configuration
nano .env
```

3. **Default User Setup**
```bash
# Create a script to hash the default password
node -e "
const bcrypt = require('bcrypt');
bcrypt.hash('admin123', 10).then(hash => console.log('Hashed password:', hash));
"

# Update the users array in server.js with the hashed password
```

4. **Open Interpreter Setup**
```bash
# Install Open Interpreter
pip install open-interpreter

# Install additional dependencies for local models (optional)
pip install torch transformers

# Test installation
python3 -c "import interpreter; print('Open Interpreter installed successfully')"

# Configure for local use (optional)
interpreter --local
```

### Frontend Setup

1. **Create React App**
```bash
cd .. # Back to dockerai directory
npx create-react-app frontend
cd frontend

# Install additional dependencies
npm install lucide-react

# Replace src/App.js with the frontend code
# Update src/index.css with Tailwind CSS
```

2. **Configure Environment**
```bash
# Create .env file for frontend
echo "REACT_APP_API_URL=http://localhost:3001/api" > .env
echo "REACT_APP_WS_URL=ws://localhost:3001" >> .env
```

## 🐳 Docker Deployment

### Option 1: Docker Compose (Recommended)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  dockerai-backend:
    build: 
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PORT=3001
      - JWT_SECRET=${JWT_SECRET}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./logs:/app/logs
    restart: unless-stopped
    networks:
      - dockerai

  dockerai-frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:80"
    environment:
      - REACT_APP_API_URL=http://localhost:3001/api
      - REACT_APP_WS_URL=ws://localhost:3001
    depends_on:
      - dockerai-backend
    restart: unless-stopped
    networks:
      - dockerai

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - dockerai-frontend
      - dockerai-backend
    restart: unless-stopped
    networks:
      - dockerai

networks:
  dockerai:
    driver: bridge
```

### Backend Dockerfile

Create `backend/Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S dockerai -u 1001

# Change ownership
RUN chown -R dockerai:nodejs /app
USER dockerai

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3
