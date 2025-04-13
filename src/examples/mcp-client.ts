import {
  Router,
  Request,
  Response,
  RequestHandler,
  NextFunction,
} from 'express'
import { v4 as uuidv4 } from 'uuid'

/**
 * MCPClient tool implementation type
 */
export interface ToolImpl<T = any> {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, any>
    required: string[]
  }
  handler: (args: T) => Promise<{
    content: Array<{ type: string; text: string }>
    isError: boolean
  }>
}

/**
 * MCPClient options
 */
export interface MCPClientOptions {
  endpoint?: string
  tools: ToolImpl[]
  serverName?: string
  serverVersion?: string
}

/**
 * MCPClient class for handling MCP protocol in Express
 */
export class MCPClient {
  private router: Router
  private endpoint: string
  private tools: ToolImpl[]
  private serverName: string
  private serverVersion: string
  private connections: Record<string, Response> = {}

  /**
   * Create a new MCPClient instance
   */
  constructor(options: MCPClientOptions) {
    this.router = Router()
    this.endpoint = options.endpoint || ''
    this.tools = options.tools || []
    this.serverName = options.serverName || 'mcp-server'
    this.serverVersion = options.serverVersion || '1.0.0'

    this.setupRoutes()
  }

  /**
   * Set up the MCP routes
   */
  private setupRoutes(): void {
    // SSE endpoint
    this.router.get('/sse', this.handleSse)

    // Message endpoint
    this.router.post('/message', this.handleMessage)
  }

  /**
   * Handle SSE connections
   */
  private handleSse = (req: Request, res: Response): void => {
    console.log(`New SSE connection to ${this.endpoint}/sse`)

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Generate session ID
    const sessionId = uuidv4()
    this.connections[sessionId] = res

    // Send a ping every 30 seconds to keep the connection alive
    const keepAliveInterval = setInterval(() => {
      res.write(': ping\n\n')
    }, 30000)

    // Send the initialize response
    const initResponse = {
      jsonrpc: '2.0',
      id: 0,
      result: {
        serverInfo: {
          name: this.serverName,
          version: this.serverVersion,
        },
        capabilities: {
          tools: {},
          prompts: {},
        },
      },
    }

    this.sendSseMessage(res, initResponse)

    // Handle client disconnect
    req.on('close', () => {
      console.log(`SSE connection closed for session ${sessionId}`)
      clearInterval(keepAliveInterval)
      delete this.connections[sessionId]
    })
  }

  /**
   * Handle message requests
   */
  private handleMessage = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const sessionId = req.query.sessionId as string

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter' })
      return
    }

    const connection = this.connections[sessionId]
    if (!connection) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Process the incoming request
    const request = req.body
    console.log(
      `Received message for endpoint ${this.endpoint}, session ${sessionId}:`,
      request,
    )

    // Handle different MCP requests
    try {
      if (request.method === 'tools/list') {
        await this.handleToolsList(request, connection, res)
      } else if (request.method === 'tools/call') {
        await this.handleToolsCall(request, connection, res)
      } else if (request.method === 'prompts/list') {
        await this.handlePromptsList(request, connection, res)
      } else if (request.method === 'initialize') {
        await this.handleInitialize(request, connection, res)
      } else {
        this.sendSseMessage(connection, {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        })
        res.json({ status: 'ok' })
      }
    } catch (error) {
      console.error(`Error handling request:`, error)
      this.sendSseMessage(connection, {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: `Internal error: ${error}`,
        },
      })
      res.json({ status: 'error', message: String(error) })
    }
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(
    request: any,
    connection: Response,
    res: Response,
  ): Promise<void> {
    // Extract just the tool definitions (omit handlers)
    const toolDefinitions = this.tools.map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    )

    this.sendSseMessage(connection, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: toolDefinitions,
      },
    })

    res.json({ status: 'ok' })
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(
    request: any,
    connection: Response,
    res: Response,
  ): Promise<void> {
    const toolName = request.params.name
    const args = request.params.arguments

    console.log(`Tool call: ${toolName}`, args)

    // Find the requested tool by name
    const toolImpl = this.tools.find((tool) => tool.name === toolName)

    let result

    if (toolImpl) {
      try {
        // Call the tool's handler with the arguments
        result = await toolImpl.handler(args)
      } catch (error) {
        console.error(`Error executing tool ${toolName}:`, error)
        result = {
          content: [
            {
              type: 'text',
              text: `Error executing tool ${toolName}: ${error}`,
            },
          ],
          isError: true,
        }
      }
    } else {
      result = {
        content: [
          {
            type: 'text',
            text: `Error: Unknown tool '${toolName}'`,
          },
        ],
        isError: true,
      }
    }

    this.sendSseMessage(connection, {
      jsonrpc: '2.0',
      id: request.id,
      result: result,
    })

    res.json({ status: 'ok' })
  }

  /**
   * Handle prompts/list request
   */
  private async handlePromptsList(
    request: any,
    connection: Response,
    res: Response,
  ): Promise<void> {
    this.sendSseMessage(connection, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        prompts: [],
      },
    })

    res.json({ status: 'ok' })
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(
    request: any,
    connection: Response,
    res: Response,
  ): Promise<void> {
    this.sendSseMessage(connection, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        serverInfo: {
          name: this.serverName,
          version: this.serverVersion,
        },
        capabilities: {
          tools: {},
          prompts: {},
        },
      },
    })

    res.json({ status: 'ok' })
  }

  /**
   * Send SSE message
   */
  private sendSseMessage(res: Response, data: any): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  /**
   * Return middleware that can be used with Express
   */
  public middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      this.router(req, res, next)
    }
  }

  /**
   * Backward compatibility method for handler()
   */
  public handler(): RequestHandler {
    return this.middleware()
  }
}
