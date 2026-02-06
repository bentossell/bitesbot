#!/usr/bin/env node
/**
 * Test Dashboard Server
 * 
 * Serves the test visualization UI and provides an API to run tests.
 * 
 * Usage:
 *   node server.js [port]
 *   
 * Default port: 3456
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2]) || 3456;
const PROJECT_ROOT = resolve(__dirname, '../..');

// MIME types
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Run tests and return JSON results
async function runTests(type = 'all') {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    let args = ['run', '--reporter=json'];
    if (type === 'unit') {
      args.push('--exclude', '**/*.e2e.ts');
    } else if (type === 'e2e') {
      args.push('--config', 'vitest.e2e.config.ts');
    }
    
    const proc = spawn('npx', ['vitest', ...args], {
      cwd: PROJECT_ROOT,
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    
    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      
      try {
        // Extract JSON from output (vitest outputs JSON directly when using json reporter)
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const results = JSON.parse(jsonMatch[0]);
          resolve({ success: true, results, duration, stdout, stderr });
        } else {
          resolve({ success: false, error: 'No JSON output', stdout, stderr, duration });
        }
      } catch (e) {
        resolve({ success: false, error: e.message, stdout, stderr, duration });
      }
    });
    
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message, stdout, stderr, duration: Date.now() - startTime });
    });
  });
}

// Get test file list without running tests
async function getTestFiles() {
  return new Promise((resolve) => {
    const proc = spawn('find', ['tests', '-name', '*.test.ts', '-o', '-name', '*.e2e.ts'], {
      cwd: PROJECT_ROOT,
    });
    
    let stdout = '';
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.on('close', () => {
      const files = stdout.trim().split('\n').filter(Boolean).map(f => ({
        path: f,
        name: f.split('/').pop(),
        type: f.includes('.e2e.') ? 'e2e' : 'unit'
      }));
      resolve(files);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // API routes
  if (url.pathname === '/api/run-tests' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { type } = JSON.parse(body || '{}');
        console.log(`Running ${type || 'all'} tests...`);
        const result = await runTests(type);
        console.log(`Tests completed: ${result.success ? 'success' : 'failed'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  
  if (url.pathname === '/api/test-files') {
    const files = await getTestFiles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }
  
  // Serve static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = join(__dirname, filePath);
  
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  
  const ext = filePath.match(/\.[^.]+$/)?.[0] || '';
  const contentType = mimeTypes[ext] || 'text/plain';
  
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────┐
│  🧪 Test Dashboard                      │
│                                         │
│  http://localhost:${PORT}                  │
│                                         │
│  Project: ${PROJECT_ROOT.split('/').pop().padEnd(27)}│
│  Tests:   pnpm test                     │
└─────────────────────────────────────────┘
`);
});
