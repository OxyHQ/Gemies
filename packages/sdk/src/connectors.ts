/// <reference types="nativewind/types" />
/**
 * The connectors leaf entry: the providers' own remote MCP servers a person connects (Notion,
 * Linear, Slack…) and their own MCP servers by URL. The store where they are found and connected,
 * the Settings list of what was connected, the one logo every screen draws for a connector, and
 * the switch every list that grants a connected account to a gemie draws (`GrantSwitchRow`).
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
  CONNECTORS_PATH,
  connectionOfTool,
  connectorQueryKeys,
  connectorReturnTo,
  signInResult,
  useConnectionOfTool,
  useConnections,
  useConnectorActions,
  useConnectorCatalogue,
  useConnectorLogoUrl,
  useWebSignInReturn,
} from './runtime/connectors';
export type {
  Connection,
  ConnectionStatus,
  ConnectorCategory,
  ConnectorEntry,
} from './runtime/connectors';
