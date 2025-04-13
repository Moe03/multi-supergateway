#!/usr/bin/env node
import { Command } from 'commander'
import express, { Request, Response } from 'express'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import cors from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

// Parse command-line arguments
const program = new Command()

program
  .name('mcpserver')
  .description('Run an MCP server with multiple endpoints')
  .version('1.0.0')
  .requiredOption(
    '-c, --command <command>',
    'Command to run MCP server (required)',
  )
  .option('-p, --port <port>', 'Port to listen on', '8000')
  .option(
    '-e, --endpoints <endpoints>',
    'Comma-separated list of endpoints',
    '/agent-1,/agent-2',
  )
  .option('--cors', 'Enable CORS', false)
  .parse(process.argv)

const options = program.opts()

// Extract options
const command = options.command
const port = parseInt(options.port, 10)
const endpoints = options.endpoints.split(',').map((e: string) => e.trim())
const enableCors = options.cors

// Log configuration
console.error(`Starting MCP Server:`)
console.error(`- Command: ${command}`)
console.error(`- Port: ${port}`)
console.error(`- Endpoints: ${endpoints.join(', ')}`)
console.error(`- CORS: ${enableCors ? 'enabled' : 'disabled'}`)

// Start the MCP server process
const child: ChildProcessWithoutNullStreams = spawn(command, { shell: true })

child.on('exit', (code, signal) => {
  console.error(`MCP server exited: code=${code}, signal=${signal}`)
  process.exit(code ?? 1)
})

// Handle process termination
process.on('SIGINT', () => {
  console.error('Shutting down server...')
  child.kill('SIGINT')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.error('Shutting down server...')
  child.kill('SIGTERM')
  process.exit(0)
})

// Create Express app
const app = express()

// Enable CORS if requested
if (enableCors) {
  app.use(cors())
}

// Track sessions
const sessions: Record<
  string,
  {
    transport: SSEServerTransport
    response: express.Response
  }
> = {}

// Set up each endpoint
for (const endpointPath of endpoints) {
  // Normalize endpoint
  const normalizedEndpoint = endpointPath.startsWith('/')
    ? endpointPath
    : `/${endpointPath}`

  const finalEndpoint = normalizedEndpoint.endsWith('/')
    ? normalizedEndpoint.slice(0, -1)
    : normalizedEndpoint

  // Create paths
  const ssePath = `${finalEndpoint}/sse`
  const messagePath = `${finalEndpoint}/message`

  console.error(`Setting up endpoint: ${ssePath} and ${messagePath}`)

  // Create server
  const server = new Server(
    { name: `mcpserver-${finalEndpoint}`, version: '1.0.0' },
    { capabilities: {} },
  )

  // SSE endpoint
  app.get(ssePath, async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
    console.error(`New SSE connection from ${clientIp} to ${ssePath}`)

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    if (enableCors) {
      res.setHeader('Access-Control-Allow-Origin', '*')
    }

    // Create SSE transport
    const baseUrl = `http://localhost:${port}`
    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)

    try {
      await server.connect(sseTransport)

      const sessionId = sseTransport.sessionId
      if (sessionId) {
        sessions[sessionId] = { transport: sseTransport, response: res }

        // Set up a keep-alive for the SSE connection
        const keepAliveInterval = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch (e) {
            clearInterval(keepAliveInterval)
          }
        }, 30000)

        // Handle messages from client
        sseTransport.onmessage = (msg: JSONRPCMessage) => {
          console.error(
            `[${finalEndpoint}] Client → Server: ${JSON.stringify(msg)}`,
          )
          child.stdin.write(JSON.stringify(msg) + '\n')
        }

        // Clean up on connection close
        sseTransport.onclose = () => {
          console.error(`SSE connection closed for session ${sessionId}`)
          delete sessions[sessionId]
          clearInterval(keepAliveInterval)
        }

        sseTransport.onerror = (err) => {
          console.error(`SSE error for session ${sessionId}:`, err)
          delete sessions[sessionId]
          clearInterval(keepAliveInterval)
        }

        req.on('close', () => {
          console.error(`Client disconnected for session ${sessionId}`)
          delete sessions[sessionId]
          clearInterval(keepAliveInterval)
        })
      } else {
        console.error('Failed to get session ID')
        res.status(500).end()
      }
    } catch (error) {
      console.error('Error connecting to SSE transport:', error)
      res.status(500).end()
    }
  })

  // Message endpoint
  const messageHandler = (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string

    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter')
      return
    }

    const session = sessions[sessionId]
    if (session?.transport?.handlePostMessage) {
      console.error(`POST message for session ${sessionId}`)
      session.transport.handlePostMessage(req, res)
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
    }
  }

  app.post(messagePath, messageHandler)
}

// Health check endpoint
app.get('/health', (_req, res) => {
  res.send('ok')
})

// Start the server
app.listen(port, () => {
  console.error(`MCP Server running on port ${port}`)
  for (const endpoint of endpoints) {
    const normalizedEndpoint = endpoint.startsWith('/')
      ? endpoint
      : `/${endpoint}`
    const finalEndpoint = normalizedEndpoint.endsWith('/')
      ? normalizedEndpoint.slice(0, -1)
      : normalizedEndpoint
    console.error(
      `- ${finalEndpoint}/sse: http://localhost:${port}${finalEndpoint}/sse`,
    )
  }
})

// Process stdout from the child process
let buffer = ''
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ''

  lines.forEach((line) => {
    if (!line.trim()) return

    try {
      const jsonMsg = JSON.parse(line)
      console.error(`Server → Client: ${JSON.stringify(jsonMsg)}`)

      // Forward message to all connected clients
      for (const [sid, session] of Object.entries(sessions)) {
        try {
          session.transport.send(jsonMsg)
        } catch (err) {
          console.error(`Failed to send to session ${sid}:`, err)
          delete sessions[sid]
        }
      }
    } catch (e) {
      console.error(`Invalid JSON from server: ${line}`)
    }
  })
})

// Log stderr from the child process
child.stderr.on('data', (chunk: Buffer) => {
  console.error(`Server output: ${chunk.toString('utf8')}`)
})
