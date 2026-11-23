/**
 * The connectors leaf entry: the remote MCP servers a person connects — the providers' own
 * (Notion, Linear, Slack…), the hundreds synced from the official MCP Registry — and their own MCP
 * servers by URL. The store where they are found and connected, the Settings list of what was
 * connected, the one logo every screen draws for a connector, and the switch every list that grants
 * a connected account to a gemie draws (`GrantSwitchRow`).
 * The Gemies and the Alia apps both draw these; neither keeps a copy.
 */
export { ConnectorLogo } from './components/connectors/ConnectorLogo';
export type { ConnectorLogoProps } from './components/connectors/ConnectorLogo';
export { GemieConnectorsStore } from './components/connectors/GemieConnectorsStore';
export type { GemieConnectorsStoreProps } from './components/connectors/GemieConnectorsStore';
export { GemieConnectedConnectors } from './components/connectors/GemieConnectedConnectors';
export type { GemieConnectedConnectorsProps } from './components/connectors/GemieConnectedConnectors';
export { GrantSwitchRow } from './components/connectors/GrantSwitchRow';
export type { GrantSwitchRowProps } from './components/connectors/GrantSwitchRow';
export {
  CONNECTOR_CATEGORIES,
  CONNECTOR_ROUTES,
  CONNECTOR_SORTS,
  CONNECTOR_STORE_PAGE_SIZE,
  CONNECTOR_TRUST,
  CONNECTORS_PATH,
  addCustomConnector,
  completeConnectorSignIn,
  connectConnector,
  connectionOfTool,
  connections,
  ConnectorEntries,
  connectorReturnTo,
  connectorStore,
  connectorStoreKey,
  ConnectorStoreList,
  connectorStoreParams,
  disconnectConnector,
  reconnectConnector,
  renameConnector,
  signInResult,
  useConnectionOfTool,
  useConnections,
  useConnectorActions,
  useConnectorLogoUrl,
  useConnectorStore,
  useWebSignInReturn,
} from './runtime/connectors';
export type {
  Connection,
  ConnectionStatus,
  ConnectorCategory,
  ConnectorEntry,
  ConnectorSort,
  ConnectorClient,
  ConnectorStoreExtra,
  ConnectorStorePage,
  ConnectorStoreQuery,
  ConnectorStoreView,
  CustomConnectorInput,
  ConnectorTrust,
} from './runtime/connectors';
