#!/bin/bash

# This example shows how to run an MCP server with multiple SSE endpoints
# using the supergateway multi-sse feature

# Replace this with your own MCP server command that uses stdio
STDIO_CMD="npx -y @modelcontextprotocol/server-demo"

# Run the supergateway with multiple endpoints
npx -y supergateway --stdio "$STDIO_CMD" \
                   --port 8000 \
                   --endpoints /agent-1,/agent-2,/agent-3 \
                   --cors

# The server will now expose:
# - http://localhost:8000/agent-1/sse
# - http://localhost:8000/agent-2/sse
# - http://localhost:8000/agent-3/sse

# You can connect to any of these endpoints with Claude or other MCP clients:
# npx -y supergateway --sse http://localhost:8000/agent-1/sse 