import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Logger } from './types.js'
import { stdioToSse } from './gateways/stdioToSse.js'
import { stdioToMultiSse } from './gateways/stdioToMultiSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs } from './gateways/stdioToWs.js'

const log = (...args: any[]) => console.log('[express-mcp-adapter]', ...args)
const logStderr = (...args: any[]) =>
  console.error('[express-mcp-adapter]', ...args)

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
}

const getLogger = ({
  logLevel,
  outputTransport,
}: {
  logLevel: string
  outputTransport: string
}): Logger => {
  if (logLevel === 'none') {
    return noneLogger
  }

  if (outputTransport === 'stdio') {
    return { info: logStderr, error: logStderr }
  }

  return { info: log, error: logStderr }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      description: 'Command to run an MCP server over Stdio',
    })
    .option('sse', {
      type: 'string',
      description: 'SSE URL to connect to',
    })
    .option('outputTransport', {
      type: 'string',
      choices: ['stdio', 'sse', 'ws', 'multi-sse'],
      default: () => {
        const args = hideBin(process.argv)

        if (args.includes('--stdio')) return 'sse'
        if (args.includes('--sse')) return 'stdio'
        if (args.includes('--endpoints')) return 'multi-sse'

        return undefined
      },
      description:
        'Transport for output. Default is "sse" when using --stdio and "stdio" when using --sse.',
    })
    .option('port', {
      type: 'number',
      default: 8000,
      description: '(stdio→SSE, stdio→WS) Port for output MCP server',
    })
    .option('baseUrl', {
      type: 'string',
      default: '',
      description: '(stdio→SSE) Base URL for output MCP server',
    })
    .option('ssePath', {
      type: 'string',
      default: '/sse',
      description: '(stdio→SSE) Path for SSE subscriptions',
    })
    .option('messagePath', {
      type: 'string',
      default: '/message',
      description: '(stdio→SSE, stdio→WS) Path for messages',
    })
    .option('endpoints', {
      type: 'string',
      description:
        'Comma-separated list of endpoint paths (e.g., /agent-1,/agent-2)',
    })
    .option('logLevel', {
      choices: ['info', 'none'] as const,
      default: 'info',
      description: 'Logging level',
    })
    .option('cors', {
      type: 'boolean',
      default: false,
      description: 'Enable CORS',
    })
    .option('healthEndpoint', {
      type: 'array',
      default: [],
      description:
        'One or more endpoints returning "ok", e.g. --healthEndpoint /healthz --healthEndpoint /readyz',
    })
    .option('header', {
      type: 'array',
      default: [],
      description:
        'Headers to be added to the request headers, e.g. --header "Authorization: Bearer <token>"',
    })
    .help()
    .parseSync()

  const hasStdio = Boolean(argv.stdio)
  const hasSse = Boolean(argv.sse)
  const hasEndpoints = Boolean(argv.endpoints)

  if (hasStdio && hasSse) {
    logStderr('Error: Specify only one of --stdio or --sse, not all')
    process.exit(1)
  } else if (!hasStdio && !hasSse) {
    logStderr('Error: You must specify one of --stdio or --sse')
    process.exit(1)
  }

  // Set output transport to multi-sse if endpoints are specified
  let outputTransport = argv.outputTransport as string
  if (hasEndpoints && hasStdio) {
    outputTransport = 'multi-sse'
  }

  const logger = getLogger({
    logLevel: argv.logLevel,
    outputTransport,
  })

  logger.info('Starting...')
  logger.info(`  - outputTransport: ${outputTransport}`)

  try {
    if (hasStdio) {
      if (outputTransport === 'multi-sse') {
        // Parse endpoints
        const endpoints = argv.endpoints!.split(',').map((ep) => ep.trim())

        await stdioToMultiSse({
          stdioCmd: argv.stdio!,
          port: argv.port,
          baseUrl: argv.baseUrl,
          endpoints,
          logger,
          enableCors: argv.cors,
          healthEndpoints: argv.healthEndpoint as string[],
          cliHeaders: argv.header as string[],
        })
      } else if (outputTransport === 'sse') {
        await stdioToSse({
          stdioCmd: argv.stdio!,
          port: argv.port,
          baseUrl: argv.baseUrl,
          ssePath: argv.ssePath,
          messagePath: argv.messagePath,
          logger,
          enableCors: argv.cors,
          healthEndpoints: argv.healthEndpoint as string[],
          cliHeaders: argv.header as string[],
        })
      } else if (outputTransport === 'ws') {
        await stdioToWs({
          stdioCmd: argv.stdio!,
          port: argv.port,
          messagePath: argv.messagePath,
          logger,
          enableCors: argv.cors,
          healthEndpoints: argv.healthEndpoint as string[],
        })
      } else {
        logStderr(`Error: stdio→${outputTransport} not supported`)
        process.exit(1)
      }
    } else if (hasSse) {
      if (outputTransport === 'stdio') {
        await sseToStdio({
          sseUrl: argv.sse!,
          logger,
          headers: argv.header as string[],
        })
      } else {
        logStderr(`Error: sse→${outputTransport} not supported`)
        process.exit(1)
      }
    } else {
      logStderr('Error: Invalid input transport')
      process.exit(1)
    }
  } catch (err) {
    logStderr('Fatal error:', err)
    process.exit(1)
  }
}

main()
