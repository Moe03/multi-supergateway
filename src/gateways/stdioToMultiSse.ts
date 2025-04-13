import express, { Request, Response } from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { parseHeaders } from '../lib/parseHeaders.js'

export interface StdioToMultiSseArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  endpoints: string[]
  logger: Logger
  enableCors: boolean
  healthEndpoints: string[]
  cliHeaders?: string[]
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

export async function stdioToMultiSse(args: StdioToMultiSseArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
    endpoints,
    logger,
    enableCors,
    healthEndpoints,
    cliHeaders = [],
  } = args

  const headers = parseHeaders(cliHeaders, logger)

  logger.info(
    `  - Headers: ${cliHeaders.length ? JSON.stringify(cliHeaders) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }

  logger.info(`  - endpoints: ${endpoints.join(', ')}`)
  logger.info(`  - CORS enabled: ${enableCors}`)
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  // Start the stdio process
  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  // Create the Express app
  const app = express()

  if (enableCors) {
    app.use(cors())
  }

  // Skip body parsing for SSE message endpoints
  app.use((req, res, next) => {
    if (req.path.endsWith('/message') && req.method === 'POST') {
      return next()
    }
    return bodyParser.json()(req, res, next)
  })

  // Health check endpoints
  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  // Create an MCP server for each endpoint
  const servers: Record<string, Server> = {}
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

    logger.info(`Setting up endpoint: ${ssePath} and ${messagePath}`)

    // Create server
    const server = new Server(
      { name: `express-mcp-adapter-${finalEndpoint}`, version: getVersion() },
      { capabilities: {} },
    )

    servers[finalEndpoint] = server

    // SSE endpoint
    app.get(ssePath, async (req: Request, res: Response) => {
      logger.info(`New SSE connection from ${req.ip} to ${ssePath}`)

      setResponseHeaders({
        res,
        headers,
      })

      const fullBaseUrl = baseUrl || `http://localhost:${port}`
      const sseTransport = new SSEServerTransport(
        `${fullBaseUrl}${messagePath}`,
        res,
      )
      await server.connect(sseTransport)

      const sessionId = sseTransport.sessionId
      if (sessionId) {
        sessions[sessionId] = { transport: sseTransport, response: res }
      }

      // Set up a keep-alive for the SSE connection
      const keepAliveInterval = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch (e) {
          clearInterval(keepAliveInterval)
        }
      }, 30000)

      sseTransport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(
          `SSE → Child (endpoint ${finalEndpoint}, session ${sessionId}): ${JSON.stringify(msg)}`,
        )
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      sseTransport.onclose = () => {
        logger.info(
          `SSE connection closed (endpoint ${finalEndpoint}, session ${sessionId})`,
        )
        delete sessions[sessionId]
        clearInterval(keepAliveInterval)
      }

      sseTransport.onerror = (err) => {
        logger.error(
          `SSE error (endpoint ${finalEndpoint}, session ${sessionId}):`,
          err,
        )
        delete sessions[sessionId]
        clearInterval(keepAliveInterval)
      }

      req.on('close', () => {
        logger.info(
          `Client disconnected (endpoint ${finalEndpoint}, session ${sessionId})`,
        )
        delete sessions[sessionId]
        clearInterval(keepAliveInterval)
      })
    })

    // Message endpoint for POST messages to SSE transport
    const messageHandler = async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string

      setResponseHeaders({
        res,
        headers,
      })

      if (!sessionId) {
        res.status(400).send('Missing sessionId parameter')
        return
      }

      const session = sessions[sessionId]
      if (session?.transport?.handlePostMessage) {
        logger.info(`POST to SSE transport (session ${sessionId})`)
        await session.transport.handlePostMessage(req, res)
      } else {
        res
          .status(503)
          .send(`No active SSE connection for session ${sessionId}`)
      }
    }

    app.post(messagePath, messageHandler)
  }

  // Start the server
  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    for (const endpointPath of endpoints) {
      const normalizedEndpoint = endpointPath.startsWith('/')
        ? endpointPath
        : `/${endpointPath}`
      const finalEndpoint = normalizedEndpoint.endsWith('/')
        ? normalizedEndpoint.slice(0, -1)
        : normalizedEndpoint
      logger.info(`SSE endpoint: http://localhost:${port}${finalEndpoint}/sse`)
    }
  })

  // Process stdio output from the child process
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    lines.forEach((line) => {
      if (!line.trim()) return
      try {
        const jsonMsg = JSON.parse(line)
        logger.info('Child → SSE:', jsonMsg)
        for (const [sid, session] of Object.entries(sessions)) {
          try {
            session.transport.send(jsonMsg)
          } catch (err) {
            logger.error(`Failed to send to session ${sid}:`, err)
            delete sessions[sid]
          }
        }
      } catch {
        logger.error(`Child non-JSON: ${line}`)
      }
    })
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })
}
