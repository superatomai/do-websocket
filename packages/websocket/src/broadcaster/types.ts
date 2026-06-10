export interface BroadcastMessage {
    id:string
	type: string;
	from:{
		type?:'runtime' | 'data-agent' | 'db-bridge' | 'admin' | 'system';
		id?: string;
	};
	payload : any;
	to?:{
		type?:'runtime' | 'data-agent' | 'db-bridge' | 'admin' | 'system';
		id?: string;
	};
}

export interface Env {
	BROADCASTER: DurableObjectNamespace;
	DATABASE_URL: string;
	SUPERATOM_SERVICE_KEY: string;
}

export interface BroadcastClient {
	id: string;
	socket: WebSocket;
	type: string;
	connectedAt: number;
	metadata?: {
		userAgent: string | null;
		origin: string | null;
	};
}

/**
 * One entry in the per-project data-source registry, KEYED BY Data Source ID.
 * The DO always looks up by Data Source ID, so that is the primary key.
 *
 * - proxyId: stable id of the proxy that manages this data source.
 * - wsId:    the CURRENT owning WebSocket connection (the DO's per-connection
 *            `clientId`). Changes on reconnect, so it's refreshed on every
 *            REGISTER_PROXY — it's where the DO forwards DS_QUERY messages.
 */
export interface DataSourceRecord {
	dataSourceId: string;
	proxyId: string;
	wsId: string;
	lastSeen: number;
}
