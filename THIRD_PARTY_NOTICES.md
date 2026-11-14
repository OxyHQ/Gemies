# Third-party notices

## OpenMausBot

Selected agent-runtime algorithms are adapted from OpenMausBot commit
`0a17fa5759e7b77ce4c3a0326109ca342da9c260`.

Copyright Milind Soni and OpenMausBot contributors. Licensed under the Apache
License, Version 2.0. See https://github.com/milind-soni/OpenMausBot/blob/0a17fa5759e7b77ce4c3a0326109ca342da9c260/LICENSE.

Only files outside OpenMausBot's `enterprise/` directory are eligible for reuse.

## Connectors store data

The connectors store (`packages/api/src/lib/connector-catalogue/`) copies the listings of two public
catalogues of remote MCP servers:

- **Docker MCP Registry** (https://github.com/docker/mcp-registry): server names, descriptions,
  icons and remote endpoints from its `servers/*/server.yaml`. Copyright (c) 2025 Docker. Licensed
  under the MIT License. See https://github.com/docker/mcp-registry/blob/main/LICENSE.
- **Data from the Official MCP Registry** (https://registry.modelcontextprotocol.io): dedicated to
  the public domain under CC0 1.0 by its terms of service (§10). No partnership with or endorsement
  by the Model Context Protocol project is implied.
