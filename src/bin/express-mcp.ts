#!/usr/bin/env node
import { Command } from 'commander'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  JSONRPCMessage,
  JSONRPCRequest,
  Tool,
  ToolSchema,
  ListToolsResult,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getVersion } from '../lib/getVersion.js' // Assuming getVersion exists
import { onSignals } from '../lib/onSignals.js' // Assuming onSignals exists
import { parseHeaders } from '../lib/parseHeaders.js' // Assuming parseHeaders exists

// Parse command-line arguments
const program = new Command()

program
  .name('express-mcp')
  .description(
    "Connect to an Express server's MCP endpoint over SSE and expose as stdio. Exactly mirrors sseToStdio gateway.",
  )
  .version(getVersion())
  .requiredOption(
    '--host <url>',
    "URL of the Express server's SSE endpoint (e.g., http://localhost:8000/agent-1/sse)",
  )
  .option('--debug', 'Enable debug logging', false)
  .option(
    '--headers <headers>',
    'Comma-separated list of headers to include (format: key:value)',
    '',
  )
  .parse(process.argv)

const options = program.opts()

// Define logging functions - always log to stderr
const logInfo = (...args: any[]) =>
  console.error(`[express-mcp-adapter|INFO]`, ...args)
const logError = (...args: any[]) =>
  console.error(`[express-mcp-adapter|ERROR]`, ...args)
const logger = { info: logInfo, error: logError }

// Extract options
const sseUrl = options.host // Expects the full SSE URL
const debug = options.debug
const rawHeaders = options.headers

// Parse headers
const headers = parseHeaders(rawHeaders.split(',') || [], logger)

// Main async function following the sseToStdio pattern
async function main() {
  let sseClient: Client | null = null
  let stdioTransport: StdioServerTransport | null = null

  try {
    logInfo('Starting...')
    logInfo(`  - sse: ${sseUrl}`)
    logInfo(
      `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
    )
    logInfo('Connecting to SSE...')

    // Setup signal handling from lib
    onSignals({ logger })

    // Create SSE transport connection
    const sseTransport = new SSEClientTransport(new URL(sseUrl), {
      eventSourceInit: {
        fetch: (...props: Parameters<typeof fetch>) => {
          const [url, init = {}] = props
          const fetchFn =
            typeof fetch !== 'undefined'
              ? fetch
              : (...args: any[]) => {
                  logger.error(
                    'Global fetch not available, SSE connection might fail without polyfill.',
                  )
                  throw new Error('fetch not available')
                }
          return fetchFn(url, {
            ...init,
            headers: { ...init.headers, ...headers },
          })
        },
      },
      requestInit: {
        headers,
      },
    })

    // Create an MCP Client instance
    sseClient = new Client(
      { name: 'express-mcp-adapter', version: getVersion() },
      { capabilities: {} },
    )

    // Handle transport errors
    sseTransport.onerror = (err) => {
      logger.error('SSE transport error:', err)
      process.exit(1)
    }
    sseTransport.onclose = () => {
      logger.error('SSE connection closed by server')
      process.exit(1)
    }

    // Connect the client to the transport
    await sseClient.connect(sseTransport)
    logger.info('SSE client connected successfully')

    // --- Fetch Server Info & Tools BEFORE setting up Stdio Server ---
    const serverInfo = sseClient.getServerVersion() || {
      name: 'unknown-mcp-server',
      version: 'unknown',
    }
    let actualTools: Tool[] = []
    try {
      logInfo('Fetching tools list from server...')
      // Explicitly use the ListToolsResult schema for parsing
      const toolsResult = await sseClient.request(
        { method: 'tools/list' },
        ListToolsResultSchema,
      )
      actualTools = toolsResult.tools || []
      if (actualTools.length > 0) {
        const toolNames = actualTools.map((t) => t.name).join(', ')
        logger.info(
          `Successfully fetched ${actualTools.length} tools: ${toolNames}`,
        )
      } else {
        logger.info('Server reported no tools via tools/list')
      }
    } catch (err) {
      logger.error('Failed to fetch tools list from server:', err)
      // Proceed without tools, but log the error
    }

    // Construct the capabilities map from the fetched tools
    const actualCapabilitiesTools: Record<string, Omit<Tool, 'name'>> = {}
    actualTools.forEach((tool) => {
      actualCapabilitiesTools[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema,
      }
    })

    logger.info('Connected Server Info:', serverInfo)
    logger.info(
      'Using capabilities based on fetched tools:',
      actualCapabilitiesTools,
    )

    // Create the Stdio Server instance using the *fetched* capabilities
    const stdioServer = new Server(serverInfo, {
      capabilities: { tools: actualCapabilitiesTools, prompts: {} },
    })

    // Create and connect the Stdio Transport
    stdioTransport = new StdioServerTransport()
    await stdioServer.connect(stdioTransport)
    logger.info('Stdio server transport connected')

    // ---- Pipe messages between the two ----

    // 1. Messages/Requests coming IN from Stdio
    stdioTransport.onmessage = async (message: JSONRPCMessage) => {
      const isRequest = 'method' in message && 'id' in message
      if (isRequest) {
        const req = message as JSONRPCRequest
        if (debug) logger.info('Stdio -> SSE (Request):', req.method, req.id)

        // Special handling for initialize: Respond with fetched server info/caps
        if (req.method === 'initialize') {
          logInfo('Handling initialize request from stdio')
          const response = {
            jsonrpc: '2.0' as const,
            id: req.id,
            result: {
              serverInfo: serverInfo,
              capabilities: { tools: actualCapabilitiesTools, prompts: {} },
            },
          }
          logger.info(
            'Sending initialize response to stdio with fetched capabilities',
          )
          stdioTransport?.send(response) // Use optional chaining
          return
        }

        // Special handling for tools/list: Respond with fetched tools
        if (req.method === 'tools/list') {
          logInfo('Handling tools/list request from stdio')
          const response = {
            jsonrpc: '2.0' as const,
            id: req.id,
            result: { tools: actualTools }, // Respond with the array fetched earlier
          }
          logger.info(
            `Sending tools/list response to stdio with ${actualTools.length} tools`,
          )
          stdioTransport?.send(response)
          return
        }

        // Forward all *other* requests to the actual server via sseClient
        let result: any
        try {
          result = await sseClient!.request(req, z.any()) // Assert sseClient is not null
        } catch (err: any) {
          logger.error('Error forwarding request Stdio -> SSE:', err)
          const errorResponse = {
            jsonrpc: '2.0' as const,
            id: req.id,
            error: {
              code: err.code || -32000,
              message: err.message || 'Failed to forward request to SSE server',
            },
          }
          stdioTransport?.send(errorResponse)
          return
        }

        const response = {
          jsonrpc: '2.0' as const,
          id: req.id,
          ...(result && typeof result === 'object' && 'error' in result
            ? { error: result.error }
            : { result: result }),
        }
        if (debug) logger.info('SSE -> Stdio (Response):', response)
        stdioTransport?.send(response)
      } else {
        // Handle notifications from stdio (less common)
        if (debug) logger.info('Stdio -> SSE (Notification):', message)
        logger.info(
          'Received notification from stdio, ignoring as Client SDK has no generic notify.',
        )
      }
    }

    // 2. Messages/Notifications coming IN from the SSE Server
    sseTransport.onmessage = (message: JSONRPCMessage) => {
      if (debug) logger.info('SSE -> Stdio (Message/Notification):', message)
      stdioTransport?.send(message)
    }

    logger.info(
      'Message piping configured. Adapter is ready and will stay running.',
    )

    // Explicitly prevent the process from exiting naturally
    // The StdioServerTransport should keep it alive, but this adds extra certainty
    process.stdin.resume()
    // Keep the event loop alive indefinitely (alternative to process.stdin.resume)
    // setInterval(() => {}, 1 << 30); // Long interval, essentially keeps running
  } catch (err) {
    logError('Fatal error during initialization or connection:', err)
    sseClient?.close()
    stdioTransport?.close()
    process.exit(1)
  }
}

// Start the main function
main()
