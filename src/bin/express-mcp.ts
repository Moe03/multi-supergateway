#!/usr/bin/env node
import { Command } from 'commander'
import { v4 as uuidv4 } from 'uuid'
import { EventSourcePolyfill } from 'event-source-polyfill'

// Parse command-line arguments
const program = new Command()

program
  .name('express-mcp')
  .description(
    "Connect to an Express server's MCP endpoint over SSE and expose as stdio",
  )
  .version('1.0.0')
  .requiredOption(
    '--host <url>',
    'URL of the Express server to connect to (e.g., http://localhost:8000/agent-1)',
  )
  .option('--debug', 'Enable debug logging', false)
  .option(
    '--headers <headers>',
    'Comma-separated list of headers to include (format: key:value)',
    '',
  )
  .parse(process.argv)

const options = program.opts()

// Extract options
const hostUrl = options.host.endsWith('/')
  ? options.host.slice(0, -1)
  : options.host
const debug = options.debug
const rawHeaders = options.headers

// Parse headers
const headers: Record<string, string> = {}
if (rawHeaders) {
  rawHeaders.split(',').forEach((header: string) => {
    const [key, value] = header.trim().split(':')
    if (key && value) {
      headers[key.trim()] = value.trim()
    }
  })
}

// Ensure stdout is in binary mode (important for JSON-RPC)
if (process.stdout.isTTY) {
  process.stdout.setDefaultEncoding('utf8')
}

// Log to stderr to not interfere with stdout communication
const log = (...args: any[]) => {
  if (debug) {
    console.error('[express-mcp]', ...args)
  }
}

// Generate a session ID
const sessionId = uuidv4()
log(`Session ID: ${sessionId}`)

// Determine the SSE and message URLs
const sseUrl = `${hostUrl}/sse`
const messageUrl = `${hostUrl}/message?sessionId=${sessionId}`

log(`Connecting to SSE endpoint: ${sseUrl}`)
log(`Message endpoint: ${messageUrl}`)

// Set up EventSource connection
const eventSourceOptions = {
  headers: { ...headers },
  withCredentials: true,
}

// Connect to the SSE endpoint
const eventSource = new EventSourcePolyfill(sseUrl, eventSourceOptions)

// Handle connection events
eventSource.onopen = () => {
  log('Connected to SSE endpoint')
}

eventSource.onerror = (err) => {
  console.error('SSE connection error:', err)
  eventSource.close()
  process.exit(1)
}

// Handle SSE messages and forward to stdout
eventSource.onmessage = (event) => {
  try {
    const data = event.data
    log('Received message from server:', data)
    process.stdout.write(data + '\n')
  } catch (error) {
    console.error('Error processing message:', error)
  }
}

// Handle stdin messages and send to server
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  const lines = chunk.toString().split('\n')

  for (const line of lines) {
    if (!line.trim()) continue

    try {
      // Parse as JSON to validate, but send the original line
      JSON.parse(line)
      log('Sending message to server:', line)

      try {
        // Use Node.js built-in fetch
        const response = await fetch(messageUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: line,
        })

        if (!response.ok) {
          console.error(
            `Error from server: ${response.status} ${response.statusText}`,
          )
        }
      } catch (error) {
        console.error('Error sending message to server:', error)
      }
    } catch (error) {
      console.error('Invalid JSON input:', line)
    }
  }
})

// Handle process termination
process.on('SIGINT', () => {
  log('Shutting down...')
  eventSource.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  log('Shutting down...')
  eventSource.close()
  process.exit(0)
})
