// IndexedDB persistence layer for terminal dashboard (multi-profile)

const DB_NAME = 'terminal-dashboard';
const DB_VERSION = 2;
const STORE_NAME = 'state';

// Legacy single-workspace keys (v1)
const LEGACY_CONNECTIONS = 'connections';
const LEGACY_GROUPS = 'terminal_groups';
const LEGACY_GRID = 'grid_settings';

// Multi-profile keys
const PROFILES_INDEX = 'profiles_index';
const profileDataKey = (id: string) => `profile_data_${id}`;

function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function idbGet<T>(key: string): Promise<T | null> {
	if (typeof window === 'undefined') return null;
	try {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const store = tx.objectStore(STORE_NAME);
			const req = store.get(key);
			req.onsuccess = () => resolve((req.result as T) ?? null);
			req.onerror = () => reject(req.error);
		});
	} catch {
		return null;
	}
}

async function idbPut(key: string, data: unknown): Promise<void> {
	if (typeof window === 'undefined') return;
	try {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const req = store.put(data, key);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	} catch {
		// Silently fail
	}
}

async function idbDelete(key: string): Promise<void> {
	if (typeof window === 'undefined') return;
	try {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const req = store.delete(key);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	} catch {
		// Silently fail
	}
}

// --- Legacy single-workspace API (kept for migration) ---

export async function loadConnections<T>(): Promise<T | null> {
	return idbGet<T>(LEGACY_CONNECTIONS);
}

export async function saveConnections<T>(data: T): Promise<void> {
	return idbPut(LEGACY_CONNECTIONS, data);
}

export async function loadTerminalGroups<T>(): Promise<T | null> {
	return idbGet<T>(LEGACY_GROUPS);
}

export async function saveTerminalGroups<T>(data: T): Promise<void> {
	return idbPut(LEGACY_GROUPS, data);
}

export async function loadGridSettings<T>(): Promise<T | null> {
	return idbGet<T>(LEGACY_GRID);
}

export async function saveGridSettings<T>(data: T): Promise<void> {
	return idbPut(LEGACY_GRID, data);
}

// --- Profiles ---

export interface ProfileMetaRecord {
	id: string;
	name: string;
	updatedAt: number;
}

export interface ProfilesIndexRecord {
	activeProfileId: string;
	profiles: ProfileMetaRecord[];
}

export async function loadProfilesIndex(): Promise<ProfilesIndexRecord | null> {
	return idbGet<ProfilesIndexRecord>(PROFILES_INDEX);
}

export async function saveProfilesIndex(data: ProfilesIndexRecord): Promise<void> {
	return idbPut(PROFILES_INDEX, data);
}

export async function loadProfileData<T>(profileId: string): Promise<T | null> {
	return idbGet<T>(profileDataKey(profileId));
}

export async function saveProfileData(profileId: string, data: unknown): Promise<void> {
	return idbPut(profileDataKey(profileId), data);
}

export async function deleteProfileData(profileId: string): Promise<void> {
	return idbDelete(profileDataKey(profileId));
}

/** Read legacy single-workspace blob for one-time migration into profiles. */
export async function loadLegacyWorkspace(): Promise<{
	connections: unknown;
	terminalGroups: unknown;
	gridSettings: unknown;
} | null> {
	const [connections, terminalGroups, gridSettings] = await Promise.all([
		loadConnections(),
		loadTerminalGroups(),
		loadGridSettings(),
	]);
	if (connections == null && terminalGroups == null && gridSettings == null) return null;
	return { connections, terminalGroups, gridSettings };
}
