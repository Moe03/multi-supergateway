import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Logger } from './types.js'
import { stdioToSse } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs } from './gateways/stdioToWs.js'

const log = (...args: any[]) => console.log('[supergateway]', ...args)
const logStderr = (...args: any[]) => console.error('[supergateway]', ...args)

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
      choices: ['stdio', 'sse', 'ws'],
      default: () => {
        const args = hideBin(process.argv)

        if (args.includes('--stdio')) return 'sse'
        if (args.includes('--sse')) return 'stdio'

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

  if (hasStdio && hasSse) {
    logStderr('Error: Specify only one of --stdio or --sse, not all')
    process.exit(1)
  } else if (!hasStdio && !hasSse) {
    logStderr('Error: You must specify one of --stdio or --sse')
    process.exit(1)
  }

  const logger = getLogger({
    logLevel: argv.logLevel,
    outputTransport: argv.outputTransport as string,
  })

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai',
  )
  logger.info(`  - outputTransport: ${argv.outputTransport}`)

  try {
    if (hasStdio) {
      if (argv.outputTransport === 'sse') {
        await stdioToSse({
          stdioCmd: argv.stdio!,
          port: argv.port,
          baseUrl: argv.baseUrl,
          ssePath: argv.ssePath,
          messagePath: argv.messagePath,
          logger,
          enableCors: argv.cors,
          healthEndpoints: argv.healthEndpoint as string[],
        })
      } else if (argv.outputTransport === 'ws') {
        await stdioToWs({
          stdioCmd: argv.stdio!,
          port: argv.port,
          messagePath: argv.messagePath,
          logger,
          enableCors: argv.cors,
          healthEndpoints: argv.healthEndpoint as string[],
        })
      } else {
        logStderr(`Error: stdio→${argv.outputTransport} not supported`)
        process.exit(1)
      }
    } else if (hasSse) {
      if (argv.outputTransport === 'stdio') {
        await sseToStdio({
          sseUrl: argv.sse!,
          logger,
          headers: argv.header as string[],
        })
      } else {
        logStderr(`Error: sse→${argv.outputTransport} not supported`)
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
