// RP Hub Admin - Archive Manager
// Handles GitHub API interactions for cloud backups

const ArchiveManager = {
    // GitHub API base
    API_BASE: 'https://api.github.com',
    
    // Get settings - directly from localStorage
    get settings() {
        let settings = {
            githubOwner: 'Mrkang168',
            githubRepo: 'rp-hub',
            githubToken: '',
            encryptionKey: ''
        };
        try {
            const saved = localStorage.getItem('rphub_admin_settings');
            if (saved) {
                const loaded = JSON.parse(saved);
                settings = { ...settings, ...loaded };
            }
        } catch (e) {
            console.error('Failed to load settings from localStorage:', e);
        }
        return settings;
    },
    
    // Get headers for GitHub API
    getHeaders() {
        return {
            'Authorization': `token ${this.settings.githubToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
    },
    
    // Get archive directory path
    getArchivePath() {
        return 'archive';
    },
    
    // Generate backup filename with date
    generateBackupName() {
        const date = new Date();
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
        const timeStr = date.toTimeString().slice(0, 8).replace(/:/g, '');
        return `rp-hub-backup-${dateStr}-${timeStr}.json`;
    },
    
    // List cloud backups
    async listCloudBackups() {
        const path = this.getArchivePath();
        
        // Get repository contents
        const response = await fetch(
            `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
            { headers: this.getHeaders() }
        );
        
        if (!response.ok) {
            if (response.status === 404) {
                return [];
            }
            throw new Error(`GitHub API error: ${response.status}`);
        }
        
        const contents = await response.json();
        
        // Filter and sort backup files
        const backups = contents
            .filter(item => item.name.startsWith('rp-hub-backup-') && item.name.endsWith('.json'))
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));
        
        return backups;
    },
    
    // Upload backup to GitHub
    async uploadBackup(data) {
        const path = `${this.getArchivePath()}/${this.generateBackupName()}`;
        const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
        
        // Check if file exists
        let sha = null;
        try {
            const existing = await fetch(
                `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
                { headers: this.getHeaders() }
            );
            if (existing.ok) {
                const existingData = await existing.json();
                sha = existingData.sha;
            }
        } catch (e) {
            // File doesn't exist, that's fine
        }
        
        // Create or update file
        const response = await fetch(
            `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
            {
                method: 'PUT',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    message: `Backup: ${data.createdAt || Date.now()}`,
                    content: content,
                    sha: sha
                })
            }
        );
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Upload failed: ${response.status}`);
        }
        
        // Clean up old backups (keep only 5 most recent)
        await this.cleanupOldBackups();
        
        return true;
    },
    
    // Download backup from GitHub
    async downloadBackup(filename) {
        const path = `${this.getArchivePath()}/${filename}`;
        
        const response = await fetch(
            `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
            { headers: this.getHeaders() }
        );
        
        if (!response.ok) {
            throw new Error(`Failed to download: ${response.status}`);
        }
        
        const data = await response.json();
        const content = decodeURIComponent(escape(atob(data.content)));
        
        return JSON.parse(content);
    },
    
    // Delete backup from GitHub
    async deleteBackup(filename) {
        const path = `${this.getArchivePath()}/${filename}`;
        
        // Get file SHA first
        const response = await fetch(
            `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
            { headers: this.getHeaders() }
        );
        
        if (!response.ok) {
            throw new Error(`Failed to get file info: ${response.status}`);
        }
        
        const fileData = await response.json();
        
        // Delete file
        const deleteResponse = await fetch(
            `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
            {
                method: 'DELETE',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    message: `Delete backup: ${filename}`,
                    sha: fileData.sha
                })
            }
        );
        
        if (!deleteResponse.ok) {
            const error = await deleteResponse.json();
            throw new Error(error.message || `Delete failed: ${response.status}`);
        }
        
        return true;
    },
    
    // Clean up old backups (keep only 5 most recent)
    async cleanupOldBackups() {
        const backups = await this.listCloudBackups();
        
        if (backups.length <= 5) {
            return;
        }
        
        // Get files to delete (older than 5 most recent)
        const toDelete = backups.slice(5);
        
        // Delete in parallel
        await Promise.all(
            toDelete.map(backup => this.deleteBackup(backup.name).catch(e => {
                console.error(`Failed to delete ${backup.name}:`, e);
            }))
        );
    },
    
    // Create archive directory if it doesn't exist
    async ensureArchiveDirectory() {
        const path = this.getArchivePath();
        
        try {
            await fetch(
                `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
                { headers: this.getHeaders() }
            );
        } catch (e) {
            // Directory doesn't exist, create it
            const response = await fetch(
                `${this.API_BASE}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
                {
                    method: 'PUT',
                    headers: this.getHeaders(),
                    body: JSON.stringify({
                        message: `Create ${path} directory`,
                        content: btoa(JSON.stringify({ type: 'dir' })),
                        isBase64: true
                    })
                }
            );
            
            // Ignore errors - directory might be created by other means
        }
    },
    
    // Auto-sync functionality
    syncInterval: null,
    hashWatcherInterval: null,
    lastSyncTime: 0,
    lastWatcherHash: null,
    
    // Schedule auto-sync
    scheduleAutoSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        
        if (!this.settings.autoSyncEnabled || !this.settings.githubToken) {
            return;
        }
        
        const intervals = {
            'realtime': 1000,      // 1 second (effectively on-demand)
            '5min': 5 * 60 * 1000,
            '15min': 15 * 60 * 1000,
            '30min': 30 * 60 * 1000,
            'hourly': 60 * 60 * 1000
        };
        
        const interval = intervals[this.settings.syncFrequency] || intervals['5min'];
        
        this.syncInterval = setInterval(() => {
            this.autoSync();
        }, interval);

        // Also sync on storage events (for cross-tab communication)
        this.setupStorageListener();

        // v2.0: 启动 hash watcher (500ms), 数据变化即触发 autoSync
        // - 同标签页内 RP Hub 主页面改了数据, archive.js 监听不到 storage 事件
        // - 轮询间隔默认 5 分钟起步, 体感 "不自动"; 改成 500ms 轮 hash 解决
        this.startHashWatcher();
    },
    
    // Setup listener for storage changes
    setupStorageListener() {
        window.addEventListener('storage', (e) => {
            if (!e.key || !e.key.startsWith('rphub_')) return;
            
            // Debounce - don't sync too frequently
            const now = Date.now();
            if (now - this.lastSyncTime < 5000) return;
            
            this.autoSync();
        });
    },
    
    // Perform auto-sync
    async autoSync() {
        if (!this.settings.githubToken) return;

        const now = Date.now();
        if (now - this.lastSyncTime < 10000) return; // Minimum 10 seconds between syncs

        this.lastSyncTime = now;

        try {
            AdminApp.updateSyncStatus('syncing');

            // Get current data (async now: 包含 IndexedDB 浏览器数据)
            const data = await AdminApp.getCurrentBackupData();
            if (!data) return;

            // Check if data has changed since last sync
            const lastSyncData = localStorage.getItem('rphub_last_sync');
            if (lastSyncData) {
                const parsed = JSON.parse(lastSyncData);
                if (parsed.hash === this.hashData(data)) {
                    // Data hasn't changed, skip sync
                    AdminApp.updateSyncStatus('ready');
                    return;
                }
            }

            // Upload to cloud
            await this.uploadBackup(data);

            // Save sync info
            localStorage.setItem('rphub_last_sync', JSON.stringify({
                hash: this.hashData(data),
                time: now
            }));

            AdminApp.updateSyncStatus('ready');
            AdminApp.refreshCloudBackupList();

            console.log('Auto-sync completed');
        } catch (e) {
            console.error('Auto-sync failed:', e);
            AdminApp.updateSyncStatus('error');
        }
    },
    
    // Simple hash function for change detection
    // v2.2: 只 hash 真实内容, 过滤掉每次调用都变的元数据:
    //   - 顶层: data.createdAt, data.userId
    //   - apiConfigs: 包装层 _encrypted/_algo/_checksum/_savedAt 只在写盘时算, hash 时只留 configs
    //   - indexedDbData: 包装层 _source/_algo/_savedAt/_size 只在写盘时算, hash 时只留 entries
    hashData(data) {
        let content = (data && typeof data === 'object' && data.data) ? data.data : data;
        if (content && typeof content === 'object') {
            const stripped = {};
            for (const k of Object.keys(content)) {
                stripped[k] = content[k];
            }
            // apiConfigs 解包, 只留 configs 数组
            if (stripped.apiConfigs && typeof stripped.apiConfigs === 'object' && stripped.apiConfigs._encrypted) {
                stripped.apiConfigs = { configs: stripped.apiConfigs.configs || [] };
            }
            // indexedDbData 解包, 只留 entries
            if (stripped.indexedDbData && typeof stripped.indexedDbData === 'object' && stripped.indexedDbData.entries) {
                stripped.indexedDbData = { entries: stripped.indexedDbData.entries };
            }
            content = stripped;
        }
        const str = JSON.stringify(content);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    },
    
    // Stop auto-sync
    stopAutoSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        // v2.0: 停 hash watcher
        this.stopHashWatcher();
    },

    // v2.0: 启动 hash watcher - 5000ms 轮询, 数据变化就 autoSync
    startHashWatcher() {
        if (this.hashWatcherInterval) {
            clearInterval(this.hashWatcherInterval);
        }
        this._computeCurrentHashAsync().then(h => {
            this.lastWatcherHash = h;
        });
        this.hashWatcherInterval = setInterval(() => {
            this.checkAndTriggerSync();
        }, 5000);
    },

    // v2.0: 停 hash watcher
    stopHashWatcher() {
        if (this.hashWatcherInterval) {
            clearInterval(this.hashWatcherInterval);
            this.hashWatcherInterval = null;
        }
        this.lastWatcherHash = null;
    },

    // v2.0: 算当前数据 hash (没有就返回 null, 跳过)
    _computeCurrentHash() {
        if (typeof AdminApp === 'undefined' || typeof AdminApp.getCurrentBackupData !== 'function') return null;
        const data = AdminApp.getCurrentBackupData();
        if (!data) return null;
        return this.hashData(data);
    },

    // v2.1: 异步版, getCurrentBackupData 现在是 async (要 await IndexedDB)
    async _computeCurrentHashAsync() {
        if (typeof AdminApp === 'undefined' || typeof AdminApp.getCurrentBackupData !== 'function') return null;
        try {
            const data = await AdminApp.getCurrentBackupData();
            if (!data) return null;
            return this.hashData(data);
        } catch (e) {
            return null;
        }
    },

    // v2.0: 比对当前数据 hash, 变了就 autoSync
    // - autoSync 内部有 10s 防抖, 所以高频触发也不会刷接口
    // v2.1: 改异步, 加 _hashTickInProgress 防重叠 (500ms tick 期间 await IDB 可能跨 tick)
    _hashTickInProgress: false,
    async checkAndTriggerSync() {
        if (!this.settings.githubToken) return;
        if (this._hashTickInProgress) return; // 上一次还没算完, 这次直接跳过
        this._hashTickInProgress = true;
        try {
            const h = await this._computeCurrentHashAsync();
            if (h === null) return;
            if (h === this.lastWatcherHash) return; // 没变
            this.lastWatcherHash = h;
            // 数据变了 -> autoSync (内部会再比对 rphub_last_sync, 真正变了才上传)
            this.autoSync();
        } finally {
            this._hashTickInProgress = false;
        }
    }
};

// Hook into AdminApp login to start/stop auto-sync
const originalInit = AdminApp.init;
AdminApp.init = function() {
    originalInit.call(this);
    
    // Setup auto-sync when logged in
    if (this.isLoggedIn) {
        ArchiveManager.scheduleAutoSync();
    }
};

const originalLogout = AdminApp.logout;
AdminApp.logout = function() {
    ArchiveManager.stopAutoSync();
    originalLogout.call(this);
};

const originalSaveSettings = AdminApp.saveSettings;
AdminApp.saveSettings = function() {
    originalSaveSettings.call(this);
    
    if (this.isLoggedIn) {
        ArchiveManager.scheduleAutoSync();
    }
};
