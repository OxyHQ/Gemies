/**
 * The curated connectors: each entry is a provider's OWN hosted MCP server,
 * reached over streamable HTTP and authorized by the person through OAuth, with
 * what Gemies holds for it (an issued client, its scopes). No connector runs code
 * of ours against a provider's API, and none is a command. The store adds the
 * servers synced from the official MCP Registry (`lib/connector-catalogue/`),
 * which never override an entry here; a person may still add their own remote
 * MCP server by URL (a custom connector).
 *
 * How Gemies authenticates, beyond what the MCP SDK finds on its own
 * (RFC 9728 → RFC 8414 → Dynamic Client Registration → PKCE):
 *
 * - `client` names the environment variables holding a client the provider
 *   issued to Gemies, for providers without Dynamic Client Registration. They
 *   are read by the API on every call, sent to integrations over the internal
 *   transport and never stored with a connector. While they are unset the entry
 *   is not offered.
 * - `enabledBy` is a variable that must be `true` before the entry is offered,
 *   for a provider that admits only clients or redirect domains it approved.
 * - `scope` is the least set requested, when the provider documents granular
 *   scopes; absent, the SDK requests what the server's challenge asks.
 *
 * Where each entry's logo comes from is `lib/connector-logos.ts`: its MCP
 * Registry record (`mcpRegistryName`), then its `website`'s brand mark; once
 * connected, the server's own `serverInfo.icons`.
 */
import type { ConnectorCategory } from '../db/schema/integrations.js';

interface McpRegistryOAuth {
  scope?: string;
  client?: { envClientId: string; envClientSecret?: string };
  /**
   * The provider's documented RFC 7009 endpoint when its metadata does not
   * advertise one, and how it takes the client's credentials.
   */
  revocation?: { url: string; clientAuth: 'basic' | 'body' };
  enabledBy?: string;
}

export interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  /** The provider's hosted MCP endpoint (streamable HTTP). */
  url: string;
  oauth?: McpRegistryOAuth;
  /** The provider's website, whose brand mark is the logo when no MCP icon is published. */
  website: string;
  /** The server's name in the official MCP Registry (`registry.modelcontextprotocol.io`), when listed. */
  mcpRegistryName?: string;
  /** The provider's own documentation of this server, for the owner and for support. */
  docsUrl: string;
  featured?: boolean;
}

export const MCP_REGISTRY: readonly McpRegistryEntry[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update your Notion pages and databases',
    category: 'productivity',
    url: 'https://mcp.notion.com/mcp',
    website: 'https://www.notion.com',
    mcpRegistryName: 'com.notion/mcp',
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    featured: true,
  },
  {
    // Oxy's own: podcasts and music, and generated episodes, which belong to
    // Syra (Gemies keeps none of them). Oxy is the authorization server, with
    // Dynamic Client Registration; nothing of ours runs for it here.
    id: 'syra',
    name: 'Syra',
    description: 'Search music and podcasts, and generate episodes of your own podcasts',
    category: 'other',
    url: 'https://api.syra.fm/mcp',
    website: 'https://syra.fm',
    docsUrl: 'https://github.com/OxyHQ/Syra/blob/main/docs/mcp.md',
    featured: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, issues, pull requests and code',
    category: 'development',
    url: 'https://api.githubcopilot.com/mcp/',
    oauth: {
      // GitHub's authorization server has no Dynamic Client Registration: every
      // MCP host registers its own OAuth App.
      client: { envClientId: 'GITHUB_MCP_CLIENT_ID', envClientSecret: 'GITHUB_MCP_CLIENT_SECRET' },
      scope: 'repo read:org read:user user:email notifications',
    },
    website: 'https://github.com',
    docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    featured: true,
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles in your Linear workspace',
    category: 'productivity',
    url: 'https://mcp.linear.app/mcp',
    website: 'https://linear.app',
    mcpRegistryName: 'app.linear/linear',
    docsUrl: 'https://linear.app/docs/mcp',
    featured: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Search and read your channels and messages, and post in Slack',
    category: 'communication',
    url: 'https://mcp.slack.com/mcp',
    oauth: {
      // Slack admits only Marketplace-listed (or internal) apps to its MCP server.
      client: { envClientId: 'SLACK_MCP_CLIENT_ID', envClientSecret: 'SLACK_MCP_CLIENT_SECRET' },
      scope: [
        'search:read.public',
        'search:read.private',
        'search:read.mpim',
        'search:read.im',
        'search:read.files',
        'search:read.users',
        'channels:history',
        'groups:history',
        'im:history',
        'mpim:history',
        'channels:read',
        'groups:read',
        'im:read',
        'mpim:read',
        'chat:write',
        'files:read',
        'canvases:read',
        'canvases:write',
        'users:read',
        'users:read.email',
        'reactions:read',
        'reactions:write',
      ].join(' '),
    },
    website: 'https://slack.com',
    docsUrl: 'https://docs.slack.dev/ai/mcp-server/',
    featured: true,
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    description: 'Outlook mail and calendar, Teams, SharePoint and OneDrive (Work IQ)',
    category: 'communication',
    url: 'https://workiq.svc.cloud.microsoft/mcp',
    oauth: {
      // An Entra multi-tenant app; each organization's admin consents to Work IQ.
      client: {
        envClientId: 'MICROSOFT_MCP_CLIENT_ID',
        envClientSecret: 'MICROSOFT_MCP_CLIENT_SECRET',
      },
      scope: [
        'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask',
        'api://workiq.svc.cloud.microsoft/WorkIQ.Read',
        'api://workiq.svc.cloud.microsoft/WorkIQ.Act',
        'offline_access',
      ].join(' '),
    },
    website: 'https://www.microsoft.com',
    docsUrl:
      'https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira issues, Confluence pages and Loom videos on your Atlassian site',
    category: 'productivity',
    url: 'https://mcp.atlassian.com/v2/mcp',
    oauth: {
      scope: [
        'offline_access',
        'read:me',
        'read:account',
        'read:jira:agent-interface',
        'write:jira:agent-interface',
        'search:jira:agent-interface',
        'read:confluence:agent-interface',
        'write:confluence:agent-interface',
        'search:confluence:agent-interface',
        'read:loom:agent-interface',
        'write:loom:agent-interface',
        'search:rovo:agent-interface',
      ].join(' '),
      // Rovo MCP redirects only to domains Atlassian supports by default.
      enabledBy: 'ATLASSIAN_MCP_APPROVED',
    },
    website: 'https://www.atlassian.com',
    mcpRegistryName: 'com.atlassian/atlassian-mcp-server',
    docsUrl: 'https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/',
  },
  {
    id: 'trello',
    name: 'Trello',
    description: 'Boards, lists and cards in your Trello workspace',
    category: 'productivity',
    url: 'https://mcp.trello.com/v1',
    oauth: {
      scope: [
        'offline_access',
        'read:me',
        'read:account',
        'read:board:trello',
        'write:board:trello',
        'read:organization:trello',
        'read:member:trello',
      ].join(' '),
      // Atlassian's authorization server, with the same redirect domain rule.
      enabledBy: 'ATLASSIAN_MCP_APPROVED',
    },
    website: 'https://trello.com',
    docsUrl: 'https://github.com/atlassian/trello-mcp-server',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read designs, components and variables, and create FigJam diagrams',
    category: 'design',
    url: 'https://mcp.figma.com/mcp',
    // Figma registers only clients in its MCP catalog (by client name).
    oauth: { scope: 'mcp:connect', enabledBy: 'FIGMA_MCP_APPROVED' },
    website: 'https://www.figma.com',
    mcpRegistryName: 'com.figma.mcp/mcp',
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation',
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Search, create, edit and export your Canva designs',
    category: 'design',
    url: 'https://api.canva.com/connect/v1/mcp',
    oauth: {
      client: { envClientId: 'CANVA_MCP_CLIENT_ID', envClientSecret: 'CANVA_MCP_CLIENT_SECRET' },
      scope: [
        'profile:read',
        'design:meta:read',
        'design:content:read',
        'design:content:write',
        'folder:read',
        'folder:write',
        'comment:read',
        'comment:write',
        'asset:read',
        'asset:write',
        'brandkit:read',
        'brandtemplate:meta:read',
        'brandtemplate:content:read',
        'help:answers:read',
      ].join(' '),
      revocation: { url: 'https://api.canva.com/rest/v1/oauth/revoke', clientAuth: 'basic' },
    },
    website: 'https://www.canva.com',
    docsUrl: 'https://www.canva.dev/docs/apps/mcp/access/',
  },
  {
    id: 'zoom',
    name: 'Zoom',
    description: 'Search meetings, read recordings, transcripts and notes, and schedule meetings',
    category: 'communication',
    url: 'https://mcp.zoom.us/mcp/zoom/streamable',
    oauth: {
      client: { envClientId: 'ZOOM_MCP_CLIENT_ID', envClientSecret: 'ZOOM_MCP_CLIENT_SECRET' },
      scope: [
        'meeting:read:search',
        'meeting:read:assets',
        'meeting:write:meeting',
        'meeting:update:meeting',
        'cloud_recording:read:content',
        'cloud_recording:read:list_user_recordings',
        'my_notes:read:content',
        'agentic_search:read:search',
        'agentic_search:read:ask',
        'docs:read:export',
        'docs:write:import',
        'hub:read:content',
        'hub:write:content',
      ].join(' '),
      revocation: { url: 'https://zoom.us/oauth/revoke', clientAuth: 'basic' },
    },
    website: 'https://www.zoom.com',
    docsUrl: 'https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/',
  },
  {
    id: 'granola',
    name: 'Granola',
    description: 'Your meeting notes, transcripts and folders',
    category: 'productivity',
    url: 'https://mcp.granola.ai/mcp',
    oauth: { scope: 'mcp offline_access' },
    website: 'https://www.granola.ai',
    docsUrl: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
  },
  {
    id: 'amplitude',
    name: 'Amplitude',
    description: 'Charts, dashboards, experiments and product analytics (US data center)',
    category: 'data',
    url: 'https://mcp.amplitude.com/mcp',
    oauth: { scope: 'all:read all:write offline_access' },
    website: 'https://amplitude.com',
    mcpRegistryName: 'com.amplitude/mcp-server',
    docsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp',
  },
  {
    id: 'amplitude-eu',
    name: 'Amplitude (EU)',
    description: 'Charts, dashboards, experiments and product analytics (EU data center)',
    category: 'data',
    url: 'https://mcp.eu.amplitude.com/mcp',
    oauth: { scope: 'all:read all:write offline_access' },
    website: 'https://amplitude.com',
    mcpRegistryName: 'com.amplitude/mcp-server',
    docsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    description: 'Query, create and update records in your Salesforce org',
    category: 'data',
    url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
    oauth: {
      client: {
        envClientId: 'SALESFORCE_MCP_CLIENT_ID',
        envClientSecret: 'SALESFORCE_MCP_CLIENT_SECRET',
      },
      scope: 'mcp_api refresh_token',
    },
    website: 'https://www.salesforce.com',
    docsUrl:
      'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/servers-reference.html',
  },
];
