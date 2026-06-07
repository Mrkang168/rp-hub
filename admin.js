// RP Hub Admin - Core Logic
const AdminApp = {
    // State
    isLoggedIn: false,
    currentUser: null,
    apiConfigs: [],
    localBackups: [],
    cloudBackups: [],
    settings: {
        githubOwner: 'Mrkang168',
        githubRepo: 'rp-hub',
        githubToken: '',
        encryptionKey: '',
        autoSyncEnabled: false,
        syncFrequency: 'realtime'
    },
    
    // Constants
    ADMIN_USERNAME: null,
    ADMIN_PASSWORD: null,
    MAX_CLOUD_BACKUPS: 9,
    BOOTSTRAP_FILE: 'pat-bootstrap.json',
    BOOTSTRAP_BRANCH: 'main',
    bootstrapPushTimer: null,

    // v2.1: 浏览器 IndexedDB (主站 RP Hub 用的 RPHubDB) 读写助手
    // - 主站数据存在 IndexedDB 不是 localStorage, 之前存档只抓 localStorage 太小
    // - 借 RPHubDB.version 2 + store 'store' 这套 schema, admin 端只读不写主站
    RPHubDB_NAME: 'RPHubDB',
    RPHubDB_VERSION: 2,
    RPHubDB_STORE: 'store',
    RPHubDB_KEY_PREFIX: 'rp_hub_',
    
    _loadAdminCredentials() {
        const saved = localStorage.getItem('rphub_admin_credentials');
        if (saved) {
            try {
                const creds = JSON.parse(saved);
                this.ADMIN_USERNAME = creds.username || null;
                this.ADMIN_PASSWORD = creds.password || null;
            } catch (e) {}
        }
    },

    _saveAdminCredentials(username, password) {
        this.ADMIN_USERNAME = username;
        this.ADMIN_PASSWORD = password;
        localStorage.setItem('rphub_admin_credentials', JSON.stringify({ username, password }));
    },

    _hasAdminCredentials() {
        return !!(this.ADMIN_USERNAME && this.ADMIN_PASSWORD);
    },

    // Initialize
    init() {
        this._loadAdminCredentials();
        this.loadSettings();
        this.bindEvents();
        this.checkLoginStatus();
    },
    
    // Load settings from localStorage
    loadSettings() {
        const saved = localStorage.getItem('rphub_admin_settings');
        if (saved) {
            try {
                this.settings = { ...this.settings, ...JSON.parse(saved) };
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        }
        
        // Apply settings to form
        document.getElementById('githubOwner').value = this.settings.githubOwner || '';
        document.getElementById('githubRepo').value = this.settings.githubRepo || '';
        document.getElementById('githubToken').value = this.settings.githubToken || '';
        document.getElementById('encryptionKey').value = this.settings.encryptionKey || '';
        document.getElementById('autoSyncEnabled').checked = this.settings.autoSyncEnabled;
        document.getElementById('syncFrequency').value = this.settings.syncFrequency;
        document.getElementById('imageGenApiUrl').value = this.settings.imageGenApiUrl || '';
        document.getElementById('imageGenApiKey').value = this.settings.imageGenApiKey || '';
        document.getElementById('imageGenModel').value = this.settings.imageGenModel || 'nai-diffusion-4-5-full';
        document.getElementById('imageGenSteps').value = this.settings.imageGenSteps || 40;
        document.getElementById('imageGenScale').value = this.settings.imageGenScale || 6;
        document.getElementById('imageGenSampler').value = this.settings.imageGenSampler || 'k_dpmpp_2m_sde';
        document.getElementById('imageGenNoiseSchedule').value = this.settings.imageGenNoiseSchedule || 'karras';
        document.getElementById('imageGenNegative').value = this.settings.imageGenNegative || '';
    },
    
    // Save settings to localStorage
    saveSettings() {
        this.settings.githubOwner = document.getElementById('githubOwner').value;
        this.settings.githubRepo = document.getElementById('githubRepo').value;
        this.settings.githubToken = document.getElementById('githubToken').value;
        this.settings.encryptionKey = document.getElementById('encryptionKey').value;
        this.settings.autoSyncEnabled = document.getElementById('autoSyncEnabled').checked;
        this.settings.syncFrequency = document.getElementById('syncFrequency').value;
        this.settings.imageGenApiUrl = document.getElementById('imageGenApiUrl').value;
        this.settings.imageGenApiKey = document.getElementById('imageGenApiKey').value;
        this.settings.imageGenModel = document.getElementById('imageGenModel').value || 'nai-diffusion-4-5-full';
        this.settings.imageGenSteps = parseInt(document.getElementById('imageGenSteps').value) || 40;
        this.settings.imageGenScale = parseFloat(document.getElementById('imageGenScale').value) || 6;
        this.settings.imageGenSampler = document.getElementById('imageGenSampler').value || 'k_dpmpp_2m_sde';
        this.settings.imageGenNoiseSchedule = document.getElementById('imageGenNoiseSchedule').value || 'karras';
        this.settings.imageGenNegative = document.getElementById('imageGenNegative').value;

        localStorage.setItem('rphub_admin_settings', JSON.stringify(this.settings));
        // v2.0: 保存后异步推一份加密 PAT 到公开 bootstrap 文件, 供新浏览器自动恢复
        this.schedulePatBootstrap();
    },

    // v2.0: 公开 bootstrap URL (jsDelivr CDN, 无 auth 无 rate limit)
    getBootstrapUrl() {
        const owner = this.settings.githubOwner || 'Mrkang168';
        const repo = this.settings.githubRepo || 'rp-hub';
        return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${this.BOOTSTRAP_BRANCH}/${this.BOOTSTRAP_FILE}`;
    },

    // v2.0: 推一份加密的 PAT 到公开 bootstrap 文件 (用 Contents API, 需要 PAT auth)
    // - 加密密钥 = ADMIN_PASSWORD (单用户, 跨浏览器 bootstrap 必须用系统已知密钥才能全自动)
    async pushPatBootstrap() {
        if (!this.settings.githubToken || !this.settings.githubOwner || !this.settings.githubRepo || !this.ADMIN_PASSWORD) {
            return false;
        }
        const plainToken = this.settings.githubToken;
        // v2.0: 用 ADMIN_PASSWORD 加密 — 登录后系统自带这个密钥, 不需要用户额外输入
        const encryptedToken = CryptoJS.AES.encrypt(plainToken, this.ADMIN_PASSWORD).toString();
        const payload = { encryptedToken, updatedAt: Date.now() };
        const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
        const apiBase = 'https://api.github.com';
        const repoUrl = `${apiBase}/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${this.BOOTSTRAP_FILE}`;
        const headers = {
            'Authorization': `token ${plainToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
        };
        // 查 SHA (更新需要)
        let sha = null;
        try {
            const getRes = await fetch(`${repoUrl}?ref=${this.BOOTSTRAP_BRANCH}`, { headers });
            if (getRes.ok) {
                const getData = await getRes.json();
                sha = getData.sha;
            }
        } catch (e) { /* 新文件没关系 */ }
        // PUT
        const putRes = await fetch(repoUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
                message: 'chore: 更新 PAT bootstrap',
                content,
                sha,
                branch: this.BOOTSTRAP_BRANCH
            })
        });
        if (!putRes.ok) {
            const err = await putRes.json().catch(() => ({}));
            throw new Error(`Bootstrap 推送失败: ${putRes.status} ${err.message || ''}`);
        }
        console.log('[Bootstrap] PAT 已推送到', this.getBootstrapUrl());
        return true;
    },

    // v2.0: 防抖触发 pushPatBootstrap (saveSettings 末尾调用, 2s 静默期)
    schedulePatBootstrap() {
        if (this.bootstrapPushTimer) {
            clearTimeout(this.bootstrapPushTimer);
        }
        this.bootstrapPushTimer = setTimeout(() => {
            this.pushPatBootstrap().catch(e => {
                console.warn('[Bootstrap] 推送失败:', e.message);
            });
        }, 2000);
    },

    // v2.0: 静默从公开 bootstrap 文件恢复 PAT (登录后自动调用)
    // - 用 ADMIN_PASSWORD 解密 (单用户单密码, 不需要用户额外输入)
    // - 失败/不存在都静默返回 null
    async restorePatFromBootstrap() {
        if (!this.ADMIN_PASSWORD) return null;
        let res;
        try {
            res = await fetch(this.getBootstrapUrl(), { cache: 'no-store' });
        } catch (e) {
            return null;
        }
        if (!res.ok) {
            if (res.status === 404) return null; // 没推过
            return null;
        }
        let data;
        try { data = await res.json(); } catch (e) { return null; }
        if (!data.encryptedToken) return null;
        // 用 ADMIN_PASSWORD 解密
        const bytes = CryptoJS.AES.decrypt(data.encryptedToken, this.ADMIN_PASSWORD);
        const plainToken = bytes.toString(CryptoJS.enc.Utf8);
        if (!plainToken) return null;
        // 写回 localStorage
        this.settings.githubToken = plainToken;
        localStorage.setItem('rphub_admin_settings', JSON.stringify(this.settings));
        console.log('[Bootstrap] PAT 已从云端自动恢复');
        return plainToken;
    },

    // v2.0: 包装, 登录后/401 重试用
    // - 默认只在本地无 PAT 时才拉 (避免覆盖)
    // - force=true: 清空本地 PAT 后强拉一次 (处理本地 PAT 失效的情况)
    async tryAutoRestorePat({ force = false } = {}) {
        if (this.settings.githubToken && !force) {
            return null;
        }
        if (force) {
            this.settings.githubToken = '';
        }
        try {
            const token = await this.restorePatFromBootstrap();
            if (token) {
                this.loadSettings();
                this.checkTokenStatus();
            }
            return token;
        } catch (e) {
            return null;
        }
    },
    
    // Bind event listeners
    bindEvents() {
        // Login form
        document.getElementById('loginForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });
        
        // Logout button
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
        
        // Save token button
        document.getElementById('githubToken').addEventListener('change', () => this.saveToken());
        
        // Settings auto-save
        ['githubOwner', 'githubRepo', 'encryptionKey'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => this.saveSettings());
        });
        document.getElementById('autoSyncEnabled').addEventListener('change', () => this.saveSettings());
        document.getElementById('syncFrequency').addEventListener('change', () => this.saveSettings());
    },
    
    // Check login status
    checkLoginStatus() {
        if (!this._hasAdminCredentials()) {
            this.showSetupScreen();
            return;
        }
        const savedSession = localStorage.getItem('rphub_admin_session');
        if (savedSession) {
            try {
                const session = JSON.parse(savedSession);
                if (session.loggedIn && session.username === this.ADMIN_USERNAME) {
                    if (session.loginTime && (Date.now() - session.loginTime > 24 * 60 * 60 * 1000)) {
                        localStorage.removeItem('rphub_admin_session');
                        this.showLogin();
                        return;
                    }
                    this.isLoggedIn = true;
                    this.currentUser = session.username;
                    this.showDashboard();
                    return;
                }
            } catch (e) {}
        }
        this.showLogin();
    },
    
    // Handle login
    handleLogin() {
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');
        
        if (username === this.ADMIN_USERNAME && password === this.ADMIN_PASSWORD) {
            this.isLoggedIn = true;
            this.currentUser = username;
            
            // Save session
            localStorage.setItem('rphub_admin_session', JSON.stringify({
                loggedIn: true,
                username: username,
                loginTime: Date.now()
            }));
            
            this.showDashboard();
            this.showToast('登录成功！');
        } else {
            errorEl.textContent = '用户名或密码错误';
            errorEl.classList.remove('hidden');
        }
    },
    
    // Handle logout
    logout() {
        this.isLoggedIn = false;
        this.currentUser = null;
        localStorage.removeItem('rphub_admin_session');
        this.showLogin();
        this.showToast('已退出登录');
    },
    
    // Show login screen
    showLogin() {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('dashboard').classList.add('hidden');
        document.getElementById('setupScreen') && document.getElementById('setupScreen').classList.add('hidden');
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginError').classList.add('hidden');
    },

    // Show setup screen (first time)
    showSetupScreen() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('dashboard').classList.add('hidden');
        const setupScreen = document.getElementById('setupScreen');
        if (setupScreen) {
            setupScreen.classList.remove('hidden');
        }
    },

    // Handle first-time setup
    handleSetup() {
        const username = document.getElementById('setupUsername').value.trim();
        const password = document.getElementById('setupPassword').value;
        const confirmPassword = document.getElementById('setupConfirmPassword').value;
        const errorEl = document.getElementById('setupError');

        if (!username || !password) {
            errorEl.textContent = '用户名和密码不能为空';
            errorEl.classList.remove('hidden');
            return;
        }
        if (password.length < 4) {
            errorEl.textContent = '密码至少4个字符';
            errorEl.classList.remove('hidden');
            return;
        }
        if (password !== confirmPassword) {
            errorEl.textContent = '两次密码不一致';
            errorEl.classList.remove('hidden');
            return;
        }

        this._saveAdminCredentials(username, password);
        this.isLoggedIn = true;
        this.currentUser = username;
        localStorage.setItem('rphub_admin_session', JSON.stringify({
            loggedIn: true,
            username: username,
            loginTime: Date.now()
        }));
        document.getElementById('setupScreen').classList.add('hidden');
        this.showDashboard();
        this.showToast('管理员账户已创建！');
    },
    
    // Show dashboard
    async showDashboard() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');

        this.checkTokenStatus();
        this.loadApiConfigs();
        this.loadLocalBackups();
        // v2.0: 先尝试从云端自动恢复 PAT, 成功后再拉云端备份 (避免 401)
        await this.tryAutoRestorePat();
        this.checkTokenStatus();
        this.refreshCloudBackupList();
        // v2.2: 登录成功后自动从云端拉最新备份, 恢复浏览器缓存 (IndexedDB) + localStorage
        // - 用户换浏览器/清缓存后第一次进 admin, 登录即可拿回所有数据, 不用手动点 "恢复"
        // - 失败不阻塞, 走原来的 "发现新备份" 弹窗流程
        await this.autoRestoreFromCloudIfAny();
        this.checkForNewBackup();
    },

    // v2.2: 登录后自动从云端恢复最新备份
    // - 没有 Token / 没有 owner+repo / 401 / 云端空 全部静默跳过
    // - 成功: 写入 localStorage + IndexedDB, 加进 localBackups, 弹 toast
    // - 失败: console.error + error toast, 不抛
    async autoRestoreFromCloudIfAny() {
        if (!this.settings.githubToken || !this.settings.githubOwner || !this.settings.githubRepo) {
            console.log('[auto-restore] 缺少 Token/owner/repo, 跳过');
            return;
        }
        try {
            const backups = await ArchiveManager.listCloudBackups();
            if (!backups || backups.length === 0) {
                console.log('[auto-restore] 云端无备份, 跳过');
                return;
            }
            const latest = backups[0];
            const localLastSync = localStorage.getItem('rphub_last_sync_time');
            if (localLastSync) {
                const localTime = parseInt(localLastSync, 10);
                const cloudTime = new Date(latest.modified).getTime();
                if (!isNaN(localTime) && !isNaN(cloudTime) && localTime >= cloudTime) {
                    console.log('[auto-restore] 本地数据比云端新, 跳过自动恢复 (本地=' + localTime + ', 云端=' + cloudTime + ')');
                    return;
                }
            }
            console.log('[auto-restore] 发现云端最新备份:', latest.name, '(' + ((latest.size / 1024).toFixed(1)) + ' KB)');
            const data = await ArchiveManager.downloadBackup(latest.name);
            await this.applyBackupData(data.data);
            localStorage.setItem('rphub_last_sync_time', String(Date.now()));
            this.localBackups.unshift(data);
            if (this.localBackups.length > 20) {
                this.localBackups = this.localBackups.slice(0, 20);
            }
            localStorage.setItem('rphub_local_backups', JSON.stringify(this.localBackups));
            this.loadLocalBackups();
            this.loadApiConfigs();
            this.showToast('云端数据已自动恢复 (' + this.formatDate(data.createdAt) + ')');
            console.log('[auto-restore] 已应用云端最新备份, createdAt=' + data.createdAt);
        } catch (e) {
            console.error('[auto-restore] 自动恢复失败:', e);
            this.showToast('云端自动恢复失败: ' + e.message, 'error');
        }
    },
    
    // Check GitHub token status
    checkTokenStatus() {
        const hasToken = !!this.settings.githubToken;
        document.getElementById('tokenAlert').classList.toggle('hidden', hasToken);
        this.updateSyncStatus(hasToken ? 'ready' : 'no_token');
    },
    
    // Update sync status indicator
    updateSyncStatus(status) {
        const indicator = document.getElementById('syncIndicator');
        const text = document.getElementById('syncStatusText');
        
        const statusConfig = {
            ready: { color: 'bg-green-500', text: '就绪' },
            syncing: { color: 'bg-blue-500 animate-pulse', text: '同步中...' },
            error: { color: 'bg-red-500', text: '同步失败' },
            no_token: { color: 'bg-yellow-500', text: '未配置 Token' }
        };
        
        const config = statusConfig[status] || statusConfig.ready;
        indicator.className = `w-2 h-2 rounded-full ${config.color}`;
        text.textContent = config.text;
    },
    
    // Save GitHub Token
    saveToken() {
        this.saveSettings();
        this.checkTokenStatus();
        this.showToast('Token 已保存');
    },
    
    // Show specific tab
    showTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
            btn.classList.toggle('bg-blue-600', btn.dataset.tab === tabName);
            btn.classList.toggle('text-white', btn.dataset.tab === tabName);
            btn.classList.toggle('bg-gray-700', btn.dataset.tab !== tabName);
            btn.classList.toggle('text-gray-300', btn.dataset.tab !== tabName);
        });
        
        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.add('hidden');
        });
        document.getElementById(`tab-${tabName}`).classList.remove('hidden');
        
        // Refresh data if needed
        if (tabName === 'archive') {
            this.refreshCloudBackupList();
        } else if (tabName === 'api') {
            this.loadApiConfigs();
        }
    },
    
    // Load API configs from localStorage
    loadApiConfigs() {
        try {
            const saved = localStorage.getItem('rphub_api_configs');
            this.apiConfigs = saved ? JSON.parse(saved) : [];
            this.renderApiConfigList();
            document.getElementById('apiConfigCount').textContent = this.apiConfigs.length;
        } catch (e) {
            console.error('Failed to load API configs:', e);
            this.apiConfigs = [];
        }
    },
    
    // Save API configs to localStorage + IndexedDB (sync with main site)
    saveApiConfigs() {
        localStorage.setItem('rphub_api_configs', JSON.stringify(this.apiConfigs));
        this._syncApiConfigsToIndexedDB();
    },

    async _syncApiConfigsToIndexedDB() {
        try {
            let db = await this._openRPHubDB();
            if (!db.objectStoreNames.contains(this.RPHubDB_STORE)) {
                db.close();
                return;
            }
            const tx = db.transaction([this.RPHubDB_STORE], 'readwrite');
            const store = tx.objectStore(this.RPHubDB_STORE);
            const settingsKey = this.RPHubDB_KEY_PREFIX + 'settings';
            const getReq = store.get(settingsKey);
            getReq.onsuccess = () => {
                let settings = getReq.result || {};
                settings.apiConfigs = this.apiConfigs;
                store.put(settings, settingsKey);
            };
            tx.oncomplete = () => { db.close(); };
            tx.onerror = () => { db.close(); };
        } catch (e) {
            console.warn('[sync] API配置同步到IndexedDB失败:', e.message);
        }
    },
    
    // Render API config list
    renderApiConfigList() {
        const container = document.getElementById('apiConfigList');
        
        if (this.apiConfigs.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-gray-500">
                    暂无 API 配置，点击上方按钮添加
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.apiConfigs.map((config, index) => `
            <div class="p-4 flex items-center justify-between hover:bg-gray-700/30 transition">
                <div class="flex-1">
                    <div class="flex items-center gap-3">
                        <h4 class="font-medium text-white">${this.escapeHtml(config.name)}</h4>
                        ${config.isDefault ? '<span class="px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded">默认</span>' : ''}
                        <span class="px-2 py-0.5 ${config.type === 'image' ? 'bg-purple-500/20 text-purple-400' : 'bg-green-500/20 text-green-400'} text-xs rounded">${config.type === 'image' ? '生图' : '文本'}</span>
                    </div>
                    <p class="text-sm text-gray-400 mt-1">${this.escapeHtml(config.apiUrl)}</p>
                    <div class="flex items-center gap-2 mt-2">
                        <span class="text-xs text-gray-500">API Key:</span>
                        <span class="text-xs text-gray-400 font-mono">${this.getMaskedKey(config.apiKey)}</span>
                    </div>
                    ${config.type === 'text' ? (config.model1 ? `<p class="text-xs text-gray-500 mt-1">模型①: ${this.escapeHtml(config.model1)}</p>` : '') : (config.imageModel ? `<p class="text-xs text-gray-500 mt-1">生图模型: ${this.escapeHtml(config.imageModel)}</p>` : '')}
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="AdminApp.toggleApiKeyVisibility(${index})" class="p-2 hover:bg-gray-600 rounded-lg transition" title="显示/隐藏 Key">
                        <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                        </svg>
                    </button>
                    <button onclick="AdminApp.editApiConfig(${index})" class="p-2 hover:bg-gray-600 rounded-lg transition" title="编辑">
                        <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                        </svg>
                    </button>
                    <button onclick="AdminApp.deleteApiConfig(${index})" class="p-2 hover:bg-red-500/20 rounded-lg transition" title="删除">
                        <svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    },
    
    // Get masked API key
    getMaskedKey(key) {
        if (!key) return '(未设置)';
        if (key.length <= 8) return '********';
        return key.substring(0, 4) + '****' + key.substring(key.length - 4);
    },
    
    // Toggle API key visibility
    toggleApiKeyVisibility(index) {
        const config = this.apiConfigs[index];
        if (config._showKey) {
            config._showKey = false;
        } else {
            // Decrypt if encrypted
            const decrypted = this.decrypt(config.apiKey);
            config._decryptedKey = decrypted;
            config._showKey = true;
        }
        this.renderApiConfigList();
        
        // Show actual key for 5 seconds
        if (config._showKey) {
            const keyEl = document.querySelector(`[data-api-index="${index}"]`);
            setTimeout(() => {
                config._showKey = false;
                this.renderApiConfigList();
            }, 5000);
        }
    },
    
    _currentApiType: 'text',

    switchApiType(type) {
        this._currentApiType = type;
        const textBtn = document.getElementById('apiTypeText');
        const imageBtn = document.getElementById('apiTypeImage');
        const textFields = document.getElementById('textModeFields');
        const imageFields = document.getElementById('imageModeFields');
        if (type === 'text') {
            textBtn.className = 'flex-1 px-4 py-2 rounded-lg text-sm font-medium transition border-2 border-blue-500 bg-blue-500/20 text-blue-400';
            imageBtn.className = 'flex-1 px-4 py-2 rounded-lg text-sm font-medium transition border-2 border-gray-600 bg-gray-700/50 text-gray-400';
            textFields.classList.remove('hidden');
            imageFields.classList.add('hidden');
        } else {
            imageBtn.className = 'flex-1 px-4 py-2 rounded-lg text-sm font-medium transition border-2 border-purple-500 bg-purple-500/20 text-purple-400';
            textBtn.className = 'flex-1 px-4 py-2 rounded-lg text-sm font-medium transition border-2 border-gray-600 bg-gray-700/50 text-gray-400';
            imageFields.classList.remove('hidden');
            textFields.classList.add('hidden');
        }
    },

    async fetchModels() {
        const apiUrl = document.getElementById('apiUrl').value.trim();
        const apiKey = document.getElementById('apiKey').value;
        const statusEl = document.getElementById('fetchModelsStatus');
        const btn = document.getElementById('fetchModelsBtn');

        if (!apiUrl) {
            this.showToast('请先填写 API URL', 'error');
            return;
        }

        btn.disabled = true;
        btn.textContent = '获取中...';
        statusEl.classList.remove('hidden');
        statusEl.className = 'text-xs text-yellow-400 mt-1';
        statusEl.textContent = '正在从 API 获取模型列表...';

        let modelsUrl = apiUrl.replace(/\/+$/, '');
        if (!modelsUrl.endsWith('/models')) {
            modelsUrl += '/models';
        }

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
            headers['Authorization'] = 'Bearer ' + apiKey;
        }

        const tryFetch = async (url, label) => {
            statusEl.textContent = `尝试${label}...`;
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            let models = [];
            if (Array.isArray(data.data)) {
                models = data.data.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
            } else if (Array.isArray(data.models)) {
                models = data.models.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
            } else if (Array.isArray(data)) {
                models = data.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
            }
            return models;
        };

        try {
            let models = [];
            try {
                models = await tryFetch(modelsUrl, '直接请求');
            } catch (e1) {
                statusEl.textContent = '直接请求失败，尝试CORS代理...';
                try {
                    const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(modelsUrl);
                    models = await tryFetch(proxyUrl, 'CORS代理');
                } catch (e2) {
                    throw new Error('直接请求和CORS代理均失败（可能是跨域限制）');
                }
            }

            models.sort((a, b) => a.localeCompare(b));

            if (models.length === 0) {
                throw new Error('未找到模型');
            }

            this._populateModelSelects(models);

            statusEl.className = 'text-xs text-green-400 mt-1';
            statusEl.textContent = `成功获取 ${models.length} 个模型`;
            this.showToast(`已获取 ${models.length} 个模型`);

        } catch (e) {
            statusEl.className = 'text-xs text-red-400 mt-1';
            statusEl.textContent = '获取失败: ' + e.message;
            this._showManualModelInput();
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> 从 API 获取模型列表';
        }
    },

    _populateModelSelects(models) {
        const selectIds = ['apiModel1', 'apiModel2', 'apiModel3', 'apiModelSuggest', 'apiImageModel'];
        selectIds.forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const currentValue = select.value;
            select.innerHTML = '<option value="">-- 选择模型 --</option>';
            models.forEach(model => {
                const opt = document.createElement('option');
                opt.value = model;
                opt.textContent = model;
                select.appendChild(opt);
            });
            if (currentValue && models.includes(currentValue)) {
                select.value = currentValue;
            }
        });
    },

    _showManualModelInput() {
        this.showModal(
            '手动输入模型列表',
            `<p class="text-gray-300 mb-3">自动获取失败（可能是跨域限制），请手动粘贴模型列表。</p>
             <p class="text-gray-400 text-sm mb-2">提示：在终端执行 <code class="bg-gray-700 px-1 rounded">curl -H "Authorization: Bearer YOUR_KEY" YOUR_API_URL/v1/models</code> 获取JSON，提取模型ID。</p>
             <p class="text-gray-400 text-sm mb-3">每行一个模型ID，或粘贴JSON中的模型列表：</p>
             <textarea id="manualModelsInput" rows="8" class="w-full px-4 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y" placeholder="gemini-3.1-pro&#10;deepseek-v3&#10;gpt-4o"></textarea>`,
            [
                { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                { text: '填入', type: 'primary', onClick: () => {
                    const input = document.getElementById('manualModelsInput').value;
                    let models = [];
                    try {
                        const parsed = JSON.parse(input);
                        if (Array.isArray(parsed)) {
                            models = parsed.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
                        } else if (parsed.data && Array.isArray(parsed.data)) {
                            models = parsed.data.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
                        }
                    } catch (_) {
                        models = input.split('\n').map(l => l.trim()).filter(Boolean);
                    }
                    if (models.length > 0) {
                        models.sort((a, b) => a.localeCompare(b));
                        this._populateModelSelects(models);
                        this.showToast(`已填入 ${models.length} 个模型`);
                    }
                    this.closeModal();
                }}
            ]
        );
    },

    // Show add API modal
    showAddApiModal() {
        document.getElementById('apiModalTitle').textContent = '添加 API 配置';
        document.getElementById('apiName').value = '';
        document.getElementById('apiUrl').value = '';
        document.getElementById('apiKey').value = '';
        document.getElementById('apiModel1').value = '';
        document.getElementById('apiModel2').value = '';
        document.getElementById('apiModel3').value = '';
        document.getElementById('apiModelSuggest').value = '';
        document.getElementById('apiImageModel').value = '';
        document.getElementById('apiImageSteps').value = '';
        document.getElementById('apiImageScale').value = '';
        document.getElementById('apiImageSampler').value = '';
        document.getElementById('apiImageNoiseSchedule').value = '';
        document.getElementById('apiImageNegative').value = '';
        this._currentApiType = 'text';
        this.switchApiType('text');
        this.editingApiIndex = -1;
        document.getElementById('apiModal').classList.remove('hidden');
    },
    
    // Edit API config
    editApiConfig(index) {
        const config = this.apiConfigs[index];
        document.getElementById('apiModalTitle').textContent = '编辑 API 配置';
        document.getElementById('apiName').value = config.name;
        document.getElementById('apiUrl').value = config.apiUrl;
        document.getElementById('apiKey').value = config._decryptedKey || '';
        const type = config.type || 'text';
        this._currentApiType = type;
        this.switchApiType(type);
        if (type === 'text') {
            document.getElementById('apiModel1').value = config.model1 || '';
            document.getElementById('apiModel2').value = config.model2 || '';
            document.getElementById('apiModel3').value = config.model3 || '';
            document.getElementById('apiModelSuggest').value = config.modelSuggest || '';
        } else {
            document.getElementById('apiImageModel').value = config.imageModel || '';
            document.getElementById('apiImageSteps').value = config.imageSteps || '';
            document.getElementById('apiImageScale').value = config.imageScale || '';
            document.getElementById('apiImageSampler').value = config.imageSampler || '';
            document.getElementById('apiImageNoiseSchedule').value = config.imageNoiseSchedule || '';
            document.getElementById('apiImageNegative').value = config.imageNegative || '';
        }
        this.editingApiIndex = index;
        document.getElementById('apiModal').classList.remove('hidden');
    },
    
    // Close API modal
    closeApiModal() {
        document.getElementById('apiModal').classList.add('hidden');
        this.editingApiIndex = -1;
    },
    
    // Save API config
    saveApiConfig() {
        try {
            const name = document.getElementById('apiName').value.trim();
            const apiUrl = document.getElementById('apiUrl').value.trim();
            const apiKey = document.getElementById('apiKey').value;
            const type = this._currentApiType;
            
            if (!name || !apiUrl) {
                this.showToast('请填写名称和 API URL', 'error');
                return;
            }
            
            const config = {
                name,
                apiUrl,
                type,
                createdAt: this.editingApiIndex >= 0 ? this.apiConfigs[this.editingApiIndex].createdAt : Date.now(),
                updatedAt: Date.now()
            };
            
            if (apiKey) {
                config.apiKey = this.encrypt(apiKey);
            }

            if (type === 'text') {
                config.model1 = document.getElementById('apiModel1') ? document.getElementById('apiModel1').value.trim() : '';
                config.model2 = document.getElementById('apiModel2') ? document.getElementById('apiModel2').value.trim() : '';
                config.model3 = document.getElementById('apiModel3') ? document.getElementById('apiModel3').value.trim() : '';
                config.modelSuggest = document.getElementById('apiModelSuggest') ? document.getElementById('apiModelSuggest').value.trim() : '';
            } else {
                config.imageModel = document.getElementById('apiImageModel') ? document.getElementById('apiImageModel').value.trim() : 'nai-diffusion-4-5-full';
                config.imageSteps = parseInt(document.getElementById('apiImageSteps')?.value) || 40;
                config.imageScale = parseFloat(document.getElementById('apiImageScale')?.value) || 6;
                config.imageSampler = document.getElementById('apiImageSampler') ? document.getElementById('apiImageSampler').value.trim() : 'k_dpmpp_2m_sde';
                config.imageNoiseSchedule = document.getElementById('apiImageNoiseSchedule') ? document.getElementById('apiImageNoiseSchedule').value.trim() : 'karras';
                config.imageNegative = document.getElementById('apiImageNegative') ? document.getElementById('apiImageNegative').value : '';
            }
            
            if (this.editingApiIndex >= 0) {
                this.apiConfigs[this.editingApiIndex] = config;
                this.showToast('API 配置已更新');
            } else {
                this.apiConfigs.push(config);
                this.showToast('API 配置已添加');
            }
            
            this.saveApiConfigs();
            this.renderApiConfigList();
            document.getElementById('apiConfigCount').textContent = this.apiConfigs.length;
            this.closeApiModal();
            
            if (this.settings.autoSyncEnabled && this.settings.githubToken) {
                ArchiveManager.autoSync();
            }
        } catch (e) {
            console.error('saveApiConfig error:', e);
            this.showToast('保存失败: ' + e.message, 'error');
        }
    },
    
    // Delete API config
    deleteApiConfig(index) {
        this.showModal(
            '删除确认',
            `<p class="text-gray-300">确定要删除 API 配置 "${this.escapeHtml(this.apiConfigs[index].name)}" 吗？</p>`,
            [
                { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                { text: '删除', type: 'danger', onClick: () => {
                    this.apiConfigs.splice(index, 1);
                    this.saveApiConfigs();
                    this.renderApiConfigList();
                    document.getElementById('apiConfigCount').textContent = this.apiConfigs.length;
                    this.closeModal();
                    this.showToast('API 配置已删除');
                }}
            ]
        );
    },
    
    // Load local backups
    loadLocalBackups() {
        try {
            const saved = localStorage.getItem('rphub_local_backups');
            this.localBackups = saved ? JSON.parse(saved) : [];
            this.renderLocalBackupList();
            document.getElementById('localBackupCount').textContent = this.localBackups.length;
        } catch (e) {
            console.error('Failed to load local backups:', e);
            this.localBackups = [];
        }
    },
    
    // Render local backup list
    renderLocalBackupList() {
        const container = document.getElementById('localBackupList');
        
        if (this.localBackups.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-gray-500">
                    暂无本地存档
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.localBackups.map((backup, index) => {
            const idbInfo = backup.data?.indexedDbData;
            const idbCount = (idbInfo && typeof idbInfo._size === 'number') ? idbInfo._size : 0;
            return `
            <div class="p-4 flex items-center justify-between hover:bg-gray-700/30 transition">
                <div>
                    <div class="text-white">${this.formatDate(backup.createdAt)}</div>
                    <div class="text-xs text-gray-500 mt-1">
                        聊天记录: ${backup.data?.chatHistory?.length || 0} 条 |
                        角色卡: ${backup.data?.characters?.length || 0} 个 |
                        API配置: ${this._countApiConfigs(backup.data?.apiConfigs)} 个 |
                        浏览器数据: ${idbCount} 项
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="AdminApp.restoreLocalBackup(${index})" class="px-3 py-1 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg text-sm transition">
                        恢复
                    </button>
                    <button onclick="AdminApp.deleteLocalBackup(${index})" class="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm transition">
                        删除
                    </button>
                </div>
            </div>
        `;}).join('');
    },
    
    // Restore local backup
    restoreLocalBackup(index) {
        const backup = this.localBackups[index];
        this.showModal(
            '恢复确认',
            `<p class="text-gray-300">确定要从本地存档 "${this.formatDate(backup.createdAt)}" 恢复吗？</p><p class="text-yellow-400 text-sm mt-2">当前数据将被覆盖。</p>`,
            [
                { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                { text: '恢复', type: 'primary', onClick: async () => {
                    try {
                        await this.applyBackupData(backup.data);
                        this.closeModal();
                        this.showToast('已恢复到本地存档');
                        this.loadApiConfigs();
                    } catch (e) {
                        this.closeModal();
                        this.showToast('恢复失败: ' + e.message, 'error');
                    }
                }}
            ]
        );
    },
    
    // Delete local backup
    deleteLocalBackup(index) {
        this.showModal(
            '删除确认',
            `<p class="text-gray-300">确定要删除此本地存档吗？</p>`,
            [
                { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                { text: '删除', type: 'danger', onClick: () => {
                    this.localBackups.splice(index, 1);
                    localStorage.setItem('rphub_local_backups', JSON.stringify(this.localBackups));
                    this.renderLocalBackupList();
                    document.getElementById('localBackupCount').textContent = this.localBackups.length;
                    this.closeModal();
                    this.showToast('本地存档已删除');
                }}
            ]
        );
    },
    
    // Apply backup data — now primarily targets IndexedDB (main site storage)
    async applyBackupData(data) {
        if (data.apiConfigs) {
            const verification = this._verifyApiConfigs(data.apiConfigs);
            if (!verification.ok) {
                this.showToast('API 配置校验失败: ' + verification.error, 'error');
                console.error('[restore] apiConfigs 校验未通过, 跳过 apiConfigs 字段:', verification.error);
            } else {
                localStorage.setItem('rphub_api_configs', JSON.stringify(verification.configs));
                if (!verification.legacy) {
                    console.log('[restore] apiConfigs AES + MD5 校验通过 (' + verification.configs.length + ' 项)');
                } else {
                    console.warn('[restore] apiConfigs 为老格式 (无 MD5), 已兼容恢复 (' + verification.configs.length + ' 项)');
                }
            }
        }
        if (data.indexedDbData && data.indexedDbData.entries && Object.keys(data.indexedDbData.entries).length > 0) {
            try {
                const result = await this.restoreIndexedDbSnapshot(data.indexedDbData.entries);
                if (result.error) {
                    console.error('[restore] IndexedDB 恢复异常: 写入 ' + result.written + ' 项, 错误: ' + result.error);
                    this.showToast('IndexedDB 部分恢复: ' + result.error, 'error');
                } else {
                    console.log('[restore] IndexedDB 已恢复 ' + result.written + ' 项 (RPHubDB)');
                }
            } catch (e) {
                console.error('[restore] IndexedDB 恢复失败:', e);
            }
        } else {
            console.log('[restore] 存档不含 IndexedDB 数据, 跳过 (老存档/未启用)');
        }
    },
    
    // Check for new backup on cloud
    async checkForNewBackup() {
        if (!this.settings.githubToken || !this.settings.githubOwner || !this.settings.githubRepo) {
            return;
        }

        try {
            const backups = await ArchiveManager.listCloudBackups();
            if (backups.length === 0) return;

            // Get latest backup
            const latestBackup = backups[0];
            const dateStr = latestBackup.name.match(/(\d{8}-?\d{0,6})/)?.[1] || '19700101';
            const latestTime = new Date(latestBackup.modified).getTime();

            // Check if we have a newer local backup
            const localBackup = await this.getCurrentBackupData();
            if (!localBackup || localBackup.createdAt < latestTime) {
                // Show new backup alert
                document.getElementById('backupInfo').textContent =
                    `云端: ${this.formatDate(latestTime)}`;
                document.getElementById('newBackupAlert').classList.remove('hidden');
                window.pendingCloudBackup = latestBackup;
            }
        } catch (e) {
            console.error('Failed to check for new backup:', e);
        }
    },
    
    // Dismiss backup alert
    dismissBackupAlert() {
        document.getElementById('newBackupAlert').classList.add('hidden');
    },
    
    // Get current backup data
    async getCurrentBackupData() {
        try {
            const apiConfigs = JSON.parse(localStorage.getItem('rphub_api_configs') || '[]');
            // 存档里给 apiConfigs 加一层:
            //   - _encrypted / _algo: 标识 AES 加密 (apiKey 字段已经是 AES 密文) + MD5 校验
            //   - _checksum: configs 数组序列化后的 MD5, 读取时验证完整性
            //   - configs:  原始数组 (apiKey 仍为 AES 密文, 落地后由本地的 encryptionKey 解密)
            const isActuallyEncrypted = !!this.settings.encryptionKey;
            const apiConfigsPayload = {
                _encrypted: isActuallyEncrypted,
                _algo: isActuallyEncrypted ? 'AES-256-CBC + MD5' : 'none',
                _checksum: this._md5(JSON.stringify(apiConfigs)),
                _savedAt: Date.now(),
                configs: apiConfigs
            };
            // v2.1: 同步浏览器 IndexedDB 数据 (主站 RP Hub 的角色/聊天/世界书/预设/正则等都在这里)
            let indexedDbSummary = null;
            try {
                const idbEntries = await this.getIndexedDbSnapshot();
                indexedDbSummary = this._wrapIndexedDbSnapshot(idbEntries);
            } catch (e) {
                console.warn('[backup] IndexedDB 快照失败, 继续走 localStorage 部分:', e.message);
            }
            return {
                createdAt: Date.now(),
                userId: this.ADMIN_USERNAME || 'admin',
                data: {
                    apiConfigs: apiConfigsPayload,
                    indexedDbData: indexedDbSummary
                }
            };
        } catch (e) {
            console.error('Failed to get current backup data:', e);
            return null;
        }
    },

    // MD5 哈希 (用于存档完整性校验, MD5 单向不可逆, 不会泄露 apiKey 内容)
    _md5(text) {
        if (text === undefined || text === null) return '';
        return CryptoJS.MD5(String(text)).toString();
    },

    // 校验并提取存档里的 apiConfigs
    // - 新格式: { _encrypted: true, _checksum, configs: [...] }
    // - 老格式: 直接是数组 (没加密没校验, 兼容老存档)
    _verifyApiConfigs(payload) {
        if (!payload) return { ok: false, error: 'apiConfigs 为空' };
        if (Array.isArray(payload)) {
            return { ok: true, configs: payload, legacy: true };
        }
        if (payload && payload._encrypted && Array.isArray(payload.configs)) {
            const expected = payload._checksum || '';
            const actual = this._md5(JSON.stringify(payload.configs));
            if (!expected) {
                return { ok: false, error: '存档缺少 MD5 校验码, 拒绝恢复' };
            }
            if (expected !== actual) {
                return {
                    ok: false,
                    error: 'apiConfigs MD5 校验失败 (期望 ' + expected + ', 实际 ' + actual + '), 数据可能被篡改, 已拒绝恢复'
                };
            }
            return { ok: true, configs: payload.configs, legacy: false };
        }
        return { ok: false, error: 'apiConfigs 格式无法识别' };
    },

    // 从存档中提取 apiConfigs 的数量 (用于 UI 展示, 兼容新旧格式)
    _countApiConfigs(apiConfigsField) {
        if (!apiConfigsField) return 0;
        if (Array.isArray(apiConfigsField)) return apiConfigsField.length;
        if (Array.isArray(apiConfigsField.configs)) return apiConfigsField.configs.length;
        return 0;
    },

    // v2.1: 打开主站 RPHubDB, 返回 IDBDatabase (失败/不支持时 reject)
    _openRPHubDB() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                return reject(new Error('IndexedDB 不可用 (此环境无 indexedDB)'));
            }
            let req;
            try {
                req = indexedDB.open(this.RPHubDB_NAME, this.RPHubDB_VERSION);
            } catch (e) {
                return reject(e);
            }
            req.onerror = () => reject(req.error || new Error('打开 RPHubDB 失败'));
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = (e) => {
                // 主站已经建好 v2 的 store; admin 端开旧版本时会顺带创建, 不会破坏
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.RPHubDB_STORE)) {
                    db.createObjectStore(this.RPHubDB_STORE);
                }
            };
        });
    },

    // v2.1: 抓取浏览器 IndexedDB (RPHubDB) 里所有 rp_hub_* 数据
    // - 用 cursor 遍历, 复制值 (避免保留 Proxy / Vue ref 等不能结构化克隆的东西)
    // - 失败返回 null (让备份继续走, 只是不含 IDB 段)
    async getIndexedDbSnapshot() {
        let db;
        try {
            db = await this._openRPHubDB();
        } catch (e) {
            console.warn('[IndexedDB] 打开失败, 跳过浏览器数据快照:', e.message);
            return null;
        }
        return await new Promise((resolve) => {
            const snapshot = {};
            try {
                if (!db.objectStoreNames.contains(this.RPHubDB_STORE)) {
                    db.close();
                    return resolve(snapshot);
                }
                const tx = db.transaction([this.RPHubDB_STORE], 'readonly');
                const store = tx.objectStore(this.RPHubDB_STORE);
                const req = store.openCursor();
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        if (typeof cursor.key === 'string' && cursor.key.startsWith(this.RPHubDB_KEY_PREFIX)) {
                            try {
                                snapshot[cursor.key] = this._cloneForStorage(cursor.value);
                            } catch (err) {
                                console.warn('[IndexedDB] 跳过键 ' + cursor.key + ':', err.message);
                            }
                        }
                        cursor.continue();
                    } else {
                        resolve(snapshot);
                    }
                };
                req.onerror = () => {
                    console.error('[IndexedDB] cursor 出错:', req.error);
                    resolve(snapshot);
                };
            } catch (e) {
                console.error('[IndexedDB] snapshot 出错:', e);
                resolve(snapshot);
            } finally {
                try { db.close(); } catch (_) {}
            }
        });
    },

    // v2.1: 把存档里的 entries 写回 RPHubDB
    // - 走 readwrite 事务, 一次性 put 全部键
    // - 返回 { written, error?, skipped } 给上层打 log
    async restoreIndexedDbSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            return { written: 0, skipped: true };
        }
        const keys = Object.keys(snapshot).filter(k => typeof k === 'string' && k.startsWith(this.RPHubDB_KEY_PREFIX));
        if (keys.length === 0) {
            return { written: 0, skipped: true };
        }
        let db;
        try {
            db = await this._openRPHubDB();
        } catch (e) {
            console.warn('[IndexedDB] 打开失败, 无法恢复浏览器数据:', e.message);
            return { written: 0, skipped: true, error: e.message };
        }
        return await new Promise((resolve) => {
            try {
                if (!db.objectStoreNames.contains(this.RPHubDB_STORE)) {
                    db.close();
                    return resolve({ written: 0, skipped: true, error: 'store 不存在' });
                }
                const tx = db.transaction([this.RPHubDB_STORE], 'readwrite');
                const store = tx.objectStore(this.RPHubDB_STORE);
                let written = 0;
                let skipped = 0;
                keys.forEach((key) => {
                    try {
                        const getReq = store.get(key);
                        getReq.onsuccess = () => {
                            if (getReq.result === undefined) {
                                store.put(snapshot[key], key);
                                written++;
                            } else {
                                skipped++;
                            }
                        };
                    } catch (e) {
                        console.warn('[IndexedDB] 写入键 ' + key + ' 失败:', e.message);
                    }
                });
                tx.oncomplete = () => {
                    try { db.close(); } catch (_) {}
                    if (skipped > 0) console.log('[IndexedDB] 合并恢复: 写入 ' + written + ' 项, 跳过已有 ' + skipped + ' 项');
                    resolve({ written, skipped });
                };
                tx.onerror = () => {
                    try { db.close(); } catch (_) {}
                    resolve({ written, error: (tx.error && tx.error.message) || '事务失败' });
                };
                tx.onabort = () => {
                    try { db.close(); } catch (_) {}
                    resolve({ written, error: (tx.error && tx.error.message) || '事务中断' });
                };
            } catch (e) {
                console.error('[IndexedDB] restore 出错:', e);
                try { db.close(); } catch (_) {}
                resolve({ written: 0, error: e.message });
            }
        });
    },

    // v2.1: 备份时把 IndexedDB 数据塞进 data.indexedDbData
    // - 加一层包装: _source / _savedAt / _size / entries
    // - entries 是 { key -> cloneOfValue }
    _wrapIndexedDbSnapshot(entries) {
        const safe = entries && typeof entries === 'object' ? entries : {};
        return {
            _source: 'RPHubDB',
            _algo: 'IDB-cursor+structuredClone',
            _savedAt: Date.now(),
            _size: Object.keys(safe).length,
            entries: safe
        };
    },

    // v2.1: 简单的 deep clone, 处理 Vue Proxy / Date / TypedArray 等
    _cloneForStorage(value) {
        if (value === null || value === undefined) return value;
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) {}
        }
        try { return JSON.parse(JSON.stringify(value)); } catch (e) {
            console.warn('[clone] 跳过不可序列化值:', e.message);
            return null;
        }
    },
    
    // Manual backup
    async manualBackup() {
        if (!this.settings.githubToken) {
            this.showToast('请先配置 GitHub Token', 'error');
            this.showTab('settings');
            return;
        }

        const data = await this.getCurrentBackupData();
        if (!data) {
            this.showToast('获取备份数据失败', 'error');
            return;
        }
        
        // Add to local backups
        this.localBackups.unshift(data);
        if (this.localBackups.length > 20) {
            this.localBackups = this.localBackups.slice(0, 20);
        }
        localStorage.setItem('rphub_local_backups', JSON.stringify(this.localBackups));
        this.renderLocalBackupList();
        
        // Upload to cloud
        this.updateSyncStatus('syncing');
        try {
            await ArchiveManager.uploadBackup(data);
            this.updateSyncStatus('ready');
            this.showToast('备份已上传到云端');
            this.refreshCloudBackupList();
            
            // Trigger auto-sync if enabled
            if (this.settings.autoSyncEnabled) {
                ArchiveManager.scheduleAutoSync();
            }
        } catch (e) {
            this.updateSyncStatus('error');
            this.showToast('上传失败: ' + e.message, 'error');
        }
    },
    
    // Manual restore from cloud
    async manualRestore() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    this.showModal(
                        '导入确认',
                        `<p class="text-gray-300">确定要从文件 "${file.name}" 恢复数据吗？</p><p class="text-yellow-400 text-sm mt-2">当前数据将被覆盖。</p>`,
                        [
                            { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                            { text: '导入', type: 'primary', onClick: async () => {
                                try {
                                    await this.applyBackupData(data.data || data);
                                    this.closeModal();
                                    this.showToast('数据已从文件恢复');
                                    this.loadApiConfigs();
                                } catch (e) {
                                    this.closeModal();
                                    this.showToast('导入失败: ' + e.message, 'error');
                                }
                            }}
                        ]
                    );
                } catch (e) {
                    this.showToast('文件格式错误', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    },
    
    // Download backup to local
    async downloadBackup() {
        const data = await this.getCurrentBackupData();
        if (!data) {
            this.showToast('获取备份数据失败', 'error');
            return;
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rp-hub-backup-${this.formatDateForFile(Date.now())}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('备份已下载');
    },
    
    // Clear local data
    confirmClearLocalData() {
        this.showModal(
            '危险操作',
            `<p class="text-red-400 font-semibold">这将删除浏览器中的所有本地数据！</p><p class="text-gray-300 mt-2">包括 IndexedDB (角色卡/聊天记录/设置等) 和 localStorage (API 配置等)。此操作不可撤销。</p>`,
            [
                { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                { text: '全部删除', type: 'danger', onClick: async () => {
                    const keys = [
                        'rphub_chat_history',
                        'rphub_characters',
                        'rphub_api_configs',
                        'rphub_settings',
                        'rphub_world_infos',
                        'rphub_regex_presets',
                        'rphub_local_backups'
                    ];
                    keys.forEach(key => localStorage.removeItem(key));
                    try {
                        await this._clearIndexedDB();
                    } catch (e) {
                        console.error('[clear] IndexedDB 清空失败:', e);
                    }
                    this.closeModal();
                    this.showToast('本地数据已清除 (含 IndexedDB)');
                    this.loadLocalBackups();
                    this.loadApiConfigs();
                }}
            ]
        );
    },

    async _clearIndexedDB() {
        let db;
        try {
            db = await this._openRPHubDB();
        } catch (e) { return; }
        return new Promise((resolve) => {
            try {
                if (!db.objectStoreNames.contains(this.RPHubDB_STORE)) {
                    db.close();
                    return resolve();
                }
                const tx = db.transaction([this.RPHubDB_STORE], 'readwrite');
                const store = tx.objectStore(this.RPHubDB_STORE);
                store.clear();
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); resolve(); };
                tx.onabort = () => { db.close(); resolve(); };
            } catch (e) {
                try { db.close(); } catch (_) {}
                resolve();
            }
        });
    },
    
    // Confirm reset settings
    confirmResetSettings() {
        this.showModal(
            '重置设置',
            `<p class="text-gray-300">确定要将所有设置恢复为默认值吗？</p>`,
            [
                { text: '取消', type: 'secondary', onClick: () => this.closeModal() },
                { text: '重置', type: 'danger', onClick: () => {
                    localStorage.removeItem('rphub_admin_settings');
                    this.settings = {
                        githubOwner: 'Mrkang168',
                        githubRepo: 'rp-hub',
                        githubToken: '',
                        encryptionKey: '',
                        autoSyncEnabled: false,
                        syncFrequency: 'realtime'
                    };
                    this.loadSettings();
                    this.closeModal();
                    this.showToast('设置已重置');
                }}
            ]
        );
    },
    
    // Restore from cloud
    async restoreFromCloud() {
        if (!window.pendingCloudBackup) {
            this.showToast('没有可恢复的备份', 'error');
            return;
        }

        this.updateSyncStatus('syncing');
        try {
            const data = await ArchiveManager.downloadBackup(window.pendingCloudBackup.name);

            // Add to local backups first
            this.localBackups.unshift(data);
            if (this.localBackups.length > 20) {
                this.localBackups = this.localBackups.slice(0, 20);
            }
            localStorage.setItem('rphub_local_backups', JSON.stringify(this.localBackups));

            // Apply data
            await this.applyBackupData(data.data);

            this.dismissBackupAlert();
            this.updateSyncStatus('ready');
            this.showToast('已从云端恢复');
            this.loadLocalBackups();
            this.loadApiConfigs();
        } catch (e) {
            this.updateSyncStatus('error');
            this.showToast('恢复失败: ' + e.message, 'error');
        }
    },
    
    // Refresh cloud backup list
    async refreshCloudBackupList() {
        document.getElementById('cloudBackupList').innerHTML = `
            <div class="p-8 text-center text-gray-500">加载中...</div>
        `;

        try {
            this.cloudBackups = await ArchiveManager.listCloudBackups();
            this.renderCloudBackupList();
            document.getElementById('cloudBackupCount').textContent = this.cloudBackups.length;
        } catch (e) {
            console.error('Failed to load cloud backups:', e);
            const isAuth = /401|unauthorized/i.test(e.message);
            // v2.0 增强: 401 时强制清空本地 PAT 并从云端重拉, 然后再试一次
            if (isAuth) {
                const restored = await this.tryAutoRestorePat({ force: true });
                if (restored) {
                    try {
                        this.cloudBackups = await ArchiveManager.listCloudBackups();
                        this.renderCloudBackupList();
                        document.getElementById('cloudBackupCount').textContent = this.cloudBackups.length;
                        return;
                    } catch (e2) {
                        console.error('Retry after restore also failed:', e2);
                    }
                }
                document.getElementById('cloudBackupList').innerHTML = `
                    <div class="p-8 text-center text-red-400">
                        加载失败: GitHub API error: 401
                        <div class="mt-2 text-sm text-gray-400">
                            Token 可能已失效。<br>
                            解决: 1) 在源浏览器重新保存一次 Token (会自动推 bootstrap) <br>
                            2) 或手动把 GitHub Token 粘贴到设置里
                        </div>
                    </div>
                `;
                document.getElementById('cloudBackupCount').textContent = '-';
                return;
            }
            document.getElementById('cloudBackupList').innerHTML = `
                <div class="p-8 text-center text-red-400">加载失败: ${this.escapeHtml(e.message)}</div>
            `;
            document.getElementById('cloudBackupCount').textContent = '-';
        }
    },
    
    // Render cloud backup list
    renderCloudBackupList() {
        const container = document.getElementById('cloudBackupList');
        
        if (this.cloudBackups.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-gray-500">
                    暂无云端存档
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.cloudBackups.map(backup => `
            <div class="p-4 flex items-center justify-between hover:bg-gray-700/30 transition">
                <div>
                    <div class="text-white">${backup.name}</div>
                    <div class="text-xs text-gray-500 mt-1">
                        大小: ${(backup.size / 1024).toFixed(1)} KB |
                        修改: ${this.formatDate(new Date(backup.modified).getTime())}
                    </div>
                </div>
                <button onclick="AdminApp.restoreFromSpecificCloud('${backup.name}')" 
                    class="px-3 py-1 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg text-sm transition">
                    恢复
                </button>
            </div>
        `).join('');
    },
    
    // Restore from specific cloud backup
    async restoreFromSpecificCloud(filename) {
        this.updateSyncStatus('syncing');
        try {
            const data = await ArchiveManager.downloadBackup(filename);

            // Add to local backups
            this.localBackups.unshift(data);
            if (this.localBackups.length > 20) {
                this.localBackups = this.localBackups.slice(0, 20);
            }
            localStorage.setItem('rphub_local_backups', JSON.stringify(this.localBackups));

            // Apply data
            await this.applyBackupData(data.data);

            this.updateSyncStatus('ready');
            this.showToast('已从云端恢复');
            this.loadLocalBackups();
            this.loadApiConfigs();
        } catch (e) {
            this.updateSyncStatus('error');
            this.showToast('恢复失败: ' + e.message, 'error');
        }
    },
    
    // Modal functions
    showModal(title, content, buttons) {
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalContent').innerHTML = content;
        
        const footer = document.createElement('div');
        footer.className = 'flex gap-3 justify-end mt-6 pt-4 border-t border-gray-700';
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.textContent = btn.text;
            button.className = `px-4 py-2 rounded-lg transition ${
                btn.type === 'danger' ? 'bg-red-600 hover:bg-red-700 text-white' :
                btn.type === 'primary' ? 'bg-blue-600 hover:bg-blue-700 text-white' :
                'bg-gray-600 hover:bg-gray-500 text-white'
            }`;
            button.onclick = btn.onClick;
            footer.appendChild(button);
        });
        document.getElementById('modalContent').appendChild(footer);
        
        document.getElementById('modal').classList.remove('hidden');
    },
    
    closeModal() {
        document.getElementById('modal').classList.add('hidden');
    },
    
    // Toast notification
    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        const icon = document.getElementById('toastIcon');
        const msg = document.getElementById('toastMessage');
        
        msg.textContent = message;
        
        // Update icon color based on type
        icon.className = `w-5 h-5 ${
            type === 'error' ? 'text-red-400' :
            type === 'warning' ? 'text-yellow-400' :
            'text-green-400'
        }`;
        
        toast.classList.remove('translate-y-full', 'opacity-0');
        
        setTimeout(() => {
            toast.classList.add('translate-y-full', 'opacity-0');
        }, 3000);
    },
    
    // Encryption helpers
    encrypt(text) {
        if (!text || !this.settings.encryptionKey) return text;
        try {
            return CryptoJS.AES.encrypt(text, this.settings.encryptionKey).toString();
        } catch (e) {
            console.error('Encryption failed:', e);
            return text;
        }
    },
    
    decrypt(ciphertext) {
        if (!ciphertext || !this.settings.encryptionKey) return ciphertext;
        try {
            const bytes = CryptoJS.AES.decrypt(ciphertext, this.settings.encryptionKey);
            const decrypted = bytes.toString(CryptoJS.enc.Utf8);
            return decrypted || ciphertext;
        } catch (e) {
            console.error('Decryption failed:', e);
            return ciphertext;
        }
    },
    
    // Utility functions
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    formatDate(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    },
    
    formatDateForFile(timestamp) {
        const date = new Date(timestamp);
        return date.toISOString().slice(0, 10).replace(/-/g, '');
    }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => AdminApp.init());

// Export global functions for onclick handlers
window.showTab = (tabName) => AdminApp.showTab(tabName);
window.restoreFromCloud = () => AdminApp.restoreFromCloud();
window.dismissBackupAlert = () => AdminApp.dismissBackupAlert();
window.manualBackup = () => AdminApp.manualBackup();
window.manualRestore = () => AdminApp.manualRestore();
window.downloadBackup = () => AdminApp.downloadBackup();
window.clearLocalData = () => AdminApp.confirmClearLocalData();
window.confirmClearLocalData = () => AdminApp.confirmClearLocalData();
window.confirmResetSettings = () => AdminApp.confirmResetSettings();
window.saveToken = () => AdminApp.saveToken();
window.showAddApiModal = () => AdminApp.showAddApiModal();
window.closeApiModal = () => AdminApp.closeApiModal();
window.saveApiConfig = () => AdminApp.saveApiConfig();
window.refreshCloudBackupList = () => AdminApp.refreshCloudBackupList();
window.switchApiType = (type) => AdminApp.switchApiType(type);
window.fetchModels = () => AdminApp.fetchModels();

// Expose for console debugging and tests
window.AdminApp = AdminApp;
