# MCP Server with Multiple Endpoints

Run a single MCP server with multiple endpoints, ideal for multi-agent systems.

## Installation

```bash
npm install -g multi-mcp-server
```

## Usage

Run an MCP server with multiple endpoints:

```bash
mcpserver --command "npx -y @modelcontextprotocol/server-demo" --endpoints /agent-1,/agent-2,/agent-3
```

### Options

- `--command`, `-c`: The command to run the MCP server (required)
- `--port`, `-p`: Port to listen on (default: 8000)
- `--endpoints`, `-e`: Comma-separated list of endpoints (default: "/agent-1,/agent-2")
- `--cors`: Enable CORS (default: false)

## Example

Start a server with two agents:

```bash
mcpserver -c "npx -y @modelcontextprotocol/server-demo" -p 8000 -e "/agent-1,/agent-2" --cors
```

This creates:

- http://localhost:8000/agent-1/sse
- http://localhost:8000/agent-2/sse

## Connecting with Claude

1. Connect Claude to either endpoint:

   In Claude.ai, go to the server menu and enter:

   ```
   http://localhost:8000/agent-1/sse
   ```

2. Each endpoint runs as a separate MCP server but uses the same underlying process, so all endpoints share tools and state.

## Development

Clone and build:

```bash
git clone https://your-repo-url/multi-mcp-server.git
cd multi-mcp-server
npm install
npm run build
```

Run in development mode:

```bash
npm run dev -- -c "your-mcp-command"
```

## License

MIT

# express-mcp

A simple command-line utility to connect to an Express MCP server's endpoint.

## Installation

```bash
npm install -g express-mcp
```

## Usage

Connect to an Express MCP server:

```bash
npx -y express-mcp --host http://localhost:8000/agent-1
```

This connects to the specified endpoint's `/sse` route and exposes it as stdio, allowing you to use MCP tools through the endpoint.

### Options

- `--host <url>`: The base URL of the Express MCP endpoint (required)
- `--debug`: Enable debug logging
- `--headers <headers>`: Comma-separated list of headers to include (format: key:value)

## Examples

### Basic connection

```bash
express-mcp --host http://localhost:8000/agent-1
```

### With debug logging

```bash
express-mcp --host http://localhost:8000/agent-2 --debug
```

### With custom headers

```bash
express-mcp --host http://localhost:8000/agent-1 --headers "Authorization:Bearer token,X-Custom:value"
```

## Integration with Claude Desktop

You can use `express-mcp` with Claude Desktop by adding it to your MCP server configuration:

```json
{
  "mcpServers": {
    "myExpressMcpServer": {
      "command": "npx",
      "args": ["-y", "express-mcp", "--host", "http://localhost:8000/agent-1"]
    }
  }
}
```

## How It Works

1. Connects to the specified host's `/sse` endpoint (e.g., `http://localhost:8000/agent-1/sse`)
2. Uses the corresponding message endpoint (e.g., `http://localhost:8000/agent-1/message`)
3. Forwards SSE messages to stdout
4. Sends stdin input to the message endpoint

This allows you to use Express MCP endpoints as regular MCP servers through stdio communication.

## Development

Clone and build:

```bash
git clone https://your-repo-url/express-mcp.git
cd express-mcp
npm install
npm run build
```

Run in development mode:

```bash
npm run dev -- --host http://localhost:8000/agent-1
```

## License

MIT
