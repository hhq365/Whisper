// Import DOM utility functions
// 导入 DOM 工具函数
import {
	$,
	$$,
	$id,
	createElement,
	on,
	off,
	addClass,
	removeClass
} from './util.dom.js';

// Import theme utilities
// 导入主题工具函数
import { THEMES, getCurrentTheme, applyTheme } from './util.theme.js';

// Import i18n utilities
// 导入国际化工具函数
import { t, setLanguage, getCurrentLanguage, initI18n } from './util.i18n.js';
// Default settings
// 默认设置
const DEFAULT_SETTINGS = {
	notify: false,
	sound: false,
	theme: 'theme1'
	// 注意：我们不设置默认语言，让系统自动检测浏览器语言
	// Note: We don't set a default language, let the system auto-detect browser language
};

// Load settings from localStorage
// 从 localStorage 加载设置
function loadSettings() {
	let s = localStorage.getItem('settings');
	try {
		s = s ? JSON.parse(s) : {}
	} catch {
		s = {}
	}
	return {
		...DEFAULT_SETTINGS,
		...s
	}
}

// Save settings to localStorage
// 保存设置到 localStorage
function saveSettings(settings) {
	const {
		notify,
		sound,
		theme,
		language
	} = settings;
	localStorage.setItem('settings', JSON.stringify({
		notify,
		sound,
		theme,
		language
	}))
}

// Apply settings to the document
// 应用设置到文档
function applySettings(settings) {
	// Initialize i18n with current language setting
	// 根据当前语言设置初始化国际化
	initI18n(settings);
}

// Ask for browser notification permission
// 请求浏览器通知权限
function askNotificationPermission(callback) {
	if (Notification.requestPermission.length === 0) {
		Notification.requestPermission().then(callback)
	} else {
		Notification.requestPermission(callback)
	}
}

// Setup the settings panel UI
// 设置设置面板 UI
function setupSettingsPanel() {
	const settingsSidebar = $id('settings-sidebar');
	const settingsContent = $id('settings-content');
	const settingsTitle = $id('settings-title');
	if (!settingsSidebar || !settingsContent) return;

	const settings = loadSettings();
	
	// Update settings title
	// 更新设置标题
	if (settingsTitle) {
		settingsTitle.textContent = t('settings.title', 'Settings');
	}// Create settings content HTML
	settingsContent.innerHTML = `
		<div class="settings-section">
			<div class="settings-section-title">${t('settings.notification', 'Notification Settings')}</div>
			<div class="settings-item">
				<div class="settings-item-label">
					<div>${t('settings.desktop_notifications', 'Desktop Notifications')}</div>
				</div>
				<label class="switch">
					<input type="checkbox" id="settings-notify" ${settings.notify ? 'checked' : ''}>
					<span class="slider"></span>
				</label>
			</div>
			<div class="settings-item">
				<div class="settings-item-label">
					<div>${t('settings.sound_notifications', 'Sound Notifications')}</div>
				</div>
				<label class="switch">
					<input type="checkbox" id="settings-sound" ${settings.sound ? 'checked' : ''}>
					<span class="slider"></span>
				</label>
			</div>
		</div>
				<div class="settings-section">
			<div class="settings-section-title">${t('settings.language', 'Language Settings')}</div>
			<div class="settings-item">
				<div class="settings-item-label">
					<div>${t('settings.language_switch', 'Language')}</div>
				</div>
				<div class="language-selector">
					<select id="settings-language" class="language-select">
						<option value="en" ${settings.language === 'en' ? 'selected' : ''}>🇺🇸 English</option>
						<option value="zh" ${settings.language === 'zh' ? 'selected' : ''}>🇨🇳 中文</option>
					</select>
				</div>
			</div>
		</div>
		
		<div class="settings-section">
			<div class="settings-section-title">${t('settings.theme', 'Theme Settings')}</div>
			<div class="theme-selector" id="theme-selector">
				${THEMES.map((theme, index) => `
					<button type="button" aria-label="${t('settings.theme')} ${index + 1}" aria-pressed="${settings.theme === theme.id}" class="theme-item ${settings.theme === theme.id ? 'active' : ''}" data-theme-id="${theme.id}" style="background: ${theme.background}; background-size: cover; background-position: center;">
					</button>
				`).join('')}
			</div>
		</div>
	`;	const notifyCheckbox = $('#settings-notify', settingsContent);
	const soundCheckbox = $('#settings-sound', settingsContent);
	const languageSelect = $('#settings-language', settingsContent);
	
	// Language select event handler
	// 语言选择事件处理
	on(languageSelect, 'change', e => {
		const newLanguage = e.target.value;
		settings.language = newLanguage;
		
		// Set language immediately
		// 立即设置语言
		setLanguage(newLanguage);
		
		// Save settings
		// 保存设置
		saveSettings(settings);
		applySettings(settings);
		
		// Refresh the settings panel to show updated translations
		// 刷新设置面板以显示更新的翻译
		setTimeout(() => {
			setupSettingsPanel();
		}, 100);
	});
	
	on(notifyCheckbox, 'change', e => {
		const checked = e.target.checked;
		if (checked) {
			if (!('Notification' in window)) {
				alert('Notifications are not supported by your browser.');
				e.target.checked = false;
				return
			}
			askNotificationPermission(permission => {
				if (permission === 'granted') {
					settings.notify = true;
					settings.sound = false;
					if (soundCheckbox) soundCheckbox.checked = false;
					saveSettings(settings);
					applySettings(settings);					// 防止重复通知，添加一个标志位
					if (!settingsSidebar._notificationShown) {
						new Notification('Notifications enabled', {
							body: 'You will receive alerts here.'
						});
						settingsSidebar._notificationShown = true; // 设置标志位
					}
				} else {
					settings.notify = false;
					e.target.checked = false;
					saveSettings(settings);
					applySettings(settings);
					alert('Please allow notifications in your browser settings.')
				}
			})
		} else {
			settings.notify = false;
			saveSettings(settings);
			applySettings(settings);			// 重置标志位
			if (settingsSidebar._notificationShown) {
				settingsSidebar._notificationShown = false;
			}
		}
	});	on(soundCheckbox, 'change', e => {
		settings.sound = e.target.checked;
		if (settings.sound) {
			settings.notify = false;
			if (notifyCheckbox) notifyCheckbox.checked = false;
		}
		saveSettings(settings);
		applySettings(settings)
	});
	// Theme selection event handlers
	// 主题选择事件处理
	const themeSelector = $('#theme-selector', settingsContent);
	if (themeSelector) {
		on(themeSelector, 'click', e => {
			const themeItem = e.target.closest('.theme-item');
			const themeId = themeItem?.dataset.themeId;
			if (!themeId || themeId === settings.theme) return;
			$$('.theme-item', themeSelector).forEach(item => {
				const selected = item === themeItem;
				item.classList.toggle('active', selected);
				item.setAttribute('aria-pressed', String(selected));
			});
			settings.theme = themeId;
			applyTheme(themeId);
			saveSettings(settings);
		});
	}
}

// Check if device is mobile
function isMobile() {
	return window.innerWidth <= 768;
}

// Open the settings panel
// 打开设置面板
function openSettingsPanel() {
	const settingsSidebar = $id('settings-sidebar');
	const sidebar = $id('sidebar');
	const sidebarMask = $id('mobile-sidebar-mask');
	
	if (!settingsSidebar || !sidebar) return;
	
	if (isMobile()) {
		// Mobile: hide main sidebar and show settings sidebar with mask
		sidebar.classList.remove('mobile-open');
		settingsSidebar.style.display = 'flex';
		// Force reflow then add animation class
		settingsSidebar.offsetHeight;
		settingsSidebar.classList.add('mobile-open');
		if (sidebarMask) {
			sidebarMask.classList.add('active');
		}	} else {
		// Desktop: show settings sidebar as overlay with slide animation
		settingsSidebar.style.display = 'flex';
		// Force reflow then slide in
		settingsSidebar.offsetHeight;
		settingsSidebar.classList.add('open');
		// Keep main sidebar visible - settings sidebar is an overlay
	}
	
	// Setup settings content
	setupSettingsPanel();
}

// Close the settings panel
// 关闭设置面板
function closeSettingsPanel() {
	const settingsSidebar = $id('settings-sidebar');
	const sidebarMask = $id('mobile-sidebar-mask'); // mobile-sidebar-mask is used for settings on mobile

	if (!settingsSidebar) return;

	const animationEnded = () => {
		settingsSidebar.style.display = 'none';
		settingsSidebar.removeEventListener('transitionend', animationEnded);
	};

	if (isMobile()) {
		settingsSidebar.classList.remove('mobile-open');
		if (sidebarMask) {
			sidebarMask.classList.remove('active');
		}
		// Listen for transition end to set display none
		settingsSidebar.addEventListener('transitionend', animationEnded);
		// Fallback if transitionend doesn't fire (e.g., if no transition is defined or display:none is set too early by other means)
		setTimeout(() => {
			if (!settingsSidebar.classList.contains('mobile-open')) { // check if it wasn't reopened
				settingsSidebar.style.display = 'none';
			}
		}, 350); // Slightly longer than CSS transition
	} else {
		settingsSidebar.classList.remove('open');
		// Listen for transition end to set display none
		settingsSidebar.addEventListener('transitionend', animationEnded);
		// Fallback
		setTimeout(() => {
			if (!settingsSidebar.classList.contains('open')) { // check if it wasn't reopened
				settingsSidebar.style.display = 'none';
			}
		}, 350);
	}
}

// Initialize settings on page load
// 页面加载时初始化设置
function initSettings() {
	const settings = loadSettings();
	applySettings(settings);
	
	// Apply theme from settings
	// 从设置中应用主题
	if (settings.theme) {
		applyTheme(settings.theme);
	}
	
	// Listen for language change events to update UI
	// 监听语言变更事件以更新UI
	window.addEventListener('languageChange', () => {
		// Update settings title if settings panel is open
		// 如果设置面板已打开，更新设置标题
		const settingsTitle = $id('settings-title');
		if (settingsTitle) {
			settingsTitle.textContent = t('settings.title', 'Settings');
		}
	});
}

// Maximum notification text length
// 通知文本最大长度
const MAX_NOTIFY_TEXT_LEN = 100;

// Truncate text for notifications
// 截断通知文本
function truncateText(text) {
	return text.length > MAX_NOTIFY_TEXT_LEN ? text.slice(0, MAX_NOTIFY_TEXT_LEN) + '...' : text
}

// Play sound notification
// 播放声音通知
function playSoundNotification() {
	try {
		const ctx = new(window.AudioContext || window.webkitAudioContext)();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.frequency.value = 1000;
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start();
		gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
		setTimeout(() => {
			osc.stop();
			ctx.close()
		}, 600)
	} catch (e) {
		console.error('Sound notification failed', e)
	}
}

// Show desktop notification
// 显示桌面通知
function showDesktopNotification(roomName, text, msgType, sender) {
	if (!('Notification' in window) || Notification.permission !== 'granted') return;
	let body;
	const senderPrefix = sender ? `${sender}:` : '';	if (msgType === 'image' || msgType === 'private image') {
		body = `${senderPrefix}${t('notification.image', '[image]')}`;
		if (msgType === 'private image') {
			body = `${t('notification.private', '(Private)')}${body}`
		}
	} else if (msgType === 'text' || msgType === 'private text') {
		body = `${senderPrefix}${truncateText(text)}`;
		if (msgType === 'private text') {
			body = `${t('notification.private', '(Private)')}${body}`
		}
	} else {
		body = truncateText(text)
	}
	new Notification(`#${roomName}`, {
		body
	})
}

// Notify message entry point
// 通知消息主入口
export function notifyMessage(roomName, msgType, text, sender) {
	const settings = loadSettings();
	if (settings.notify) {
		showDesktopNotification(roomName, text, msgType, sender)
	} else if (settings.sound) {
		playSoundNotification()
	}
}
export {
	openSettingsPanel,
	closeSettingsPanel,
	initSettings
};