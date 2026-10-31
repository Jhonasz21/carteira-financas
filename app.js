"use strict";

const STORAGE_KEY = "meu-pluxee-carteira-v1";
const DEFAULT_ACCOUNTS = [
  { id: "alimentacao-1", name: "Alimentação 1", detail: "Cartão Alimentação", kind: "food", openingBalance: 0, dailyLimit: 0, lastFourDigits: "", custom: false },
  { id: "alimentacao-2", name: "Alimentação 2", detail: "Cartão Alimentação", kind: "food", openingBalance: 0, dailyLimit: 0, lastFourDigits: "", custom: false },
  { id: "refeicao-1", name: "Refeição", detail: "Cartão Refeição", kind: "meal", openingBalance: 0, dailyLimit: 0, lastFourDigits: "", custom: false },
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
let toastTimer;
let toastElement;
let voiceRecognition = null;
let voiceAccountId = null;
let firebaseMessaging = null;
let firebaseForegroundListener = false;
let registeredPushToken = "";
const cloud = {
  mode: "local",
  csrfToken: "",
  accessToken: "",
  revision: 0,
  pollTimer: null,
  polling: false,
  syncing: false,
  saving: false,
  settingsDirty: false,
};

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonthString(date = new Date()) {
  return localDateString(date).slice(0, 7);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDateString(date) === value;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function normalizeAccount(account, fallback, custom = false) {
  const kind = account.kind === "meal" ? "meal" : fallback?.kind === "meal" ? "meal" : "food";
  const lastFourDigits = typeof account.lastFourDigits === "string" && /^\d{4}$/.test(account.lastFourDigits)
    ? account.lastFourDigits
    : "";
  const name = typeof account.name === "string" && account.name.trim()
    ? account.name.trim().slice(0, 35)
    : fallback?.name;
  if (!name) return null;
  return {
    id: fallback?.id || account.id,
    name,
    detail: `Cartão ${kind === "meal" ? "Refeição" : "Alimentação"}${lastFourDigits ? ` • final ${lastFourDigits}` : ""}`,
    kind,
    openingBalance: Number.isFinite(account.openingBalance) && account.openingBalance >= 0 ? account.openingBalance : fallback?.openingBalance ?? 0,
    dailyLimit: Number.isFinite(account.dailyLimit) && account.dailyLimit >= 0 ? account.dailyLimit : fallback?.dailyLimit ?? 0,
    lastFourDigits,
    custom,
  };
}

function emptyState() {
  return { accounts: structuredClone(DEFAULT_ACCOUNTS), transactions: [] };
}

class CsvImportError extends Error {}

function loadData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return emptyState();

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed.accounts) || !Array.isArray(parsed.transactions)) {
      throw new Error("Formato de dados locais inválido.");
    }
    const accounts = DEFAULT_ACCOUNTS.flatMap((defaultAccount) => {
      const savedAccount = parsed.accounts.find((account) => account.id === defaultAccount.id);
      return savedAccount ? [normalizeAccount(savedAccount, defaultAccount)].filter(Boolean) : [];
    });
    const knownIds = new Set(accounts.map((account) => account.id));
    parsed.accounts.forEach((account) => {
      if (!account || typeof account !== "object" ||
          account.custom !== true ||
          typeof account.id !== "string" ||
          !/^card-[\da-f-]+$/i.test(account.id) ||
          knownIds.has(account.id)) return;
      const normalized = normalizeAccount(account, null, true);
      if (!normalized) return;
      accounts.push(normalized);
      knownIds.add(normalized.id);
    });
    const transactions = parsed.transactions.filter((transaction) =>
      transaction && typeof transaction === "object" &&
      typeof transaction.id === "string" &&
      accounts.some((account) => account.id === transaction.accountId) &&
      ["expense", "purchase"].includes(transaction.kind) &&
      Number.isFinite(transaction.amount) &&
      transaction.amount > 0 &&
      isValidDate(transaction.date) &&
      typeof transaction.description === "string" &&
      transaction.description.trim().length > 0,
    );
    return { accounts, transactions };
  } catch (error) {
    console.error("Não foi possível carregar os dados salvos.", error);
    window.addEventListener("DOMContentLoaded", () => {
      showToast("Não foi possível ler os dados salvos. Os valores foram reiniciados neste carregamento.", true);
    }, { once: true });
    return emptyState();
  }
}

let state = loadData();

function saveLocalCache() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error("Não foi possível salvar os dados locais.", error);
    showToast("Não foi possível salvar. Verifique o espaço disponível e as permissões do navegador.", true);
    return false;
  }
}

class CloudRequestError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.name = "CloudRequestError";
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(action, options = {}) {
  const configuredApiBase = window.MEU_PLUXEE_API_BASE;
  if (typeof configuredApiBase !== "string" || !configuredApiBase.trim()) {
    throw new CloudRequestError("Configure o endereço HTTPS da API Python em api-config.js para ativar a sincronização.", 0);
  }
  let apiUrl;
  try {
    apiUrl = new URL(configuredApiBase.trim());
  } catch {
    throw new CloudRequestError("O endereço da API em api-config.js não é uma URL válida.", 0);
  }
  if (apiUrl.protocol !== "https:" || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash || apiUrl.username || apiUrl.password) {
    throw new CloudRequestError("Configure em api-config.js somente a origem HTTPS da API, sem caminho ou parâmetros.", 0);
  }
  const apiBase = apiUrl.origin;
  const query = new URLSearchParams({ action });
  if (Number.isSafeInteger(options.revision) && options.revision >= 0) {
    query.set("revision", String(options.revision));
  }
  const fetchOptions = { ...options };
  delete fetchOptions.revision;
  const headers = { Accept: "application/json", ...options.headers };
  if (options.body) headers["Content-Type"] = "application/json";
  if (cloud.csrfToken && options.method && options.method !== "GET") {
    headers["X-CSRF-Token"] = cloud.csrfToken;
  }
  if (cloud.accessToken) headers.Authorization = `Bearer ${cloud.accessToken}`;
  const response = await fetch(`${apiBase}/api/?${query}`, {
    ...fetchOptions,
    headers,
    credentials: "omit",
    cache: "no-store",
  });
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    const message = response.status === 404
      ? "A API Python não foi encontrada (404). Confira o endereço e a configuração do proxy reverso no VPS."
      : `A API retornou uma resposta inválida (HTTP ${response.status}). Confira os logs da API Python no VPS.`;
    throw new CloudRequestError(message, response.status);
  }
  if (!response.ok) {
    throw new CloudRequestError(body.error || `O servidor respondeu com o código ${response.status}.`, response.status, body);
  }
  return body;
}

function getFirebaseWebConfig() {
  const config = window.MEU_PLUXEE_FIREBASE_CONFIG;
  const requiredFields = [
    "apiKey",
    "authDomain",
    "projectId",
    "messagingSenderId",
    "appId",
    "vapidKey",
  ];
  if (!config || requiredFields.some((field) => typeof config[field] !== "string" || !config[field].trim())) {
    throw new Error("Preencha a configuração pública do Firebase e a chave VAPID em api-config.js.");
  }
  return config;
}

async function loadFirebaseMessagingSdk() {
  if (window.firebase?.messaging) return;
  const scripts = [
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js",
  ];
  for (const source of scripts) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Não foi possível carregar o SDK de notificações do Firebase."));
      document.head.append(script);
    });
  }
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(() => {});
  });
}

async function getPushRegistrationToken(config, { requestPermission = false } = {}) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new Error("Este navegador não oferece suporte a notificações push.");
  }
  if (requestPermission && Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("A permissão para notificações não foi concedida.");
  } else if (Notification.permission !== "granted") {
    throw new Error("Ative as notificações nas permissões do navegador e tente novamente.");
  }
  await loadFirebaseMessagingSdk();
  if (!(await window.firebase.messaging.isSupported())) {
    throw new Error("Este navegador não oferece suporte ao Firebase Cloud Messaging.");
  }
  if (!window.firebase.apps.length) window.firebase.initializeApp(config);
  firebaseMessaging = window.firebase.messaging();
  const serviceWorkerRegistration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
  const token = await firebaseMessaging.getToken({
    vapidKey: config.vapidKey,
    serviceWorkerRegistration,
  });
  if (!token) throw new Error("O Firebase não gerou um token para este aparelho.");
  if (!firebaseForegroundListener) {
    firebaseMessaging.onMessage((payload) => {
      const data = payload.data || {};
      const amount = Number(data.amount);
      const value = Number.isFinite(amount) ? currency.format(amount) : "";
      const details = [data.account, data.description, value].filter(Boolean).join(" · ");
      showToast(details ? `Novo lançamento sincronizado: ${details}` : "Um novo lançamento foi sincronizado.");
    });
    firebaseForegroundListener = true;
  }
  return token;
}

function updateNotificationControls() {
  const enabled = localStorage.getItem("meu_pluxee_push_enabled") === "true";
  $("#notification-toggle").textContent = enabled ? "Desativar notificações" : "Ativar notificações";
  $("#notification-status").textContent = enabled
    ? "Notificações ativadas neste aparelho. Os detalhes do lançamento não aparecem na tela bloqueada."
    : "Ative para receber um aviso quando um novo lançamento for sincronizado. Os detalhes do lançamento não aparecem na notificação da tela bloqueada.";
}

async function togglePushNotifications() {
  const button = $("#notification-toggle");
  button.disabled = true;
  try {
    if (cloud.mode !== "connected") {
      throw new Error("Entre e conecte-se ao servidor antes de configurar notificações.");
    }
    if (localStorage.getItem("meu_pluxee_push_enabled") === "true") {
      const config = getFirebaseWebConfig();
      registeredPushToken = await getPushRegistrationToken(config);
      await apiRequest("fcm-token", {
        method: "DELETE",
        body: JSON.stringify({ token: registeredPushToken }),
      });
      await firebaseMessaging.deleteToken();
      registeredPushToken = "";
      localStorage.removeItem("meu_pluxee_push_enabled");
      updateNotificationControls();
      showToast("Notificações desativadas neste aparelho.");
      return;
    }
    const config = getFirebaseWebConfig();
    registeredPushToken = await getPushRegistrationToken(config, { requestPermission: true });
    await apiRequest("fcm-token", {
      method: "POST",
      body: JSON.stringify({ token: registeredPushToken }),
    });
    localStorage.setItem("meu_pluxee_push_enabled", "true");
    updateNotificationControls();
    showToast("Notificações ativadas neste aparelho.");
  } catch (error) {
    console.error("Não foi possível configurar as notificações Firebase.", error);
    showToast(error.message || "Não foi possível configurar as notificações.", true);
  } finally {
    button.disabled = false;
  }
}

function setConnectionStatus(mode, message = "") {
  cloud.mode = mode;
  const connected = mode === "connected";
  const badge = $("#sync-badge");
  badge.innerHTML = `<span aria-hidden="true">●</span> ${connected ? "Sincronizado" : mode === "blocked" ? "Sem sincronização" : mode === "auth-required" ? "Acesso restrito" : "Modo local"}`;
  $("#storage-status").textContent = connected
    ? "Sincronizado entre os aparelhos"
    : mode === "blocked" || mode === "auth-required"
      ? "Dados remotos indisponíveis"
      : "Dados salvos neste dispositivo";
  $("#logout-button").hidden = !connected;
  const notice = $("#connection-notice");
  notice.hidden = !message;
  notice.textContent = message;
}

async function saveData() {
  if (cloud.mode === "blocked" || cloud.mode === "auth-required") {
    showToast("Sem conexão segura com o servidor. Seus dados não foram alterados; tente novamente quando a conexão voltar.", true);
    return false;
  }
  if (cloud.mode === "connected") {
    if (cloud.saving) {
      showToast("Há outra alteração sendo salva; tente novamente em instantes.", true);
      return false;
    }
    cloud.saving = true;
    try {
      const result = await apiRequest("state", {
        method: "PUT",
        body: JSON.stringify({ revision: cloud.revision, state }),
      });
      cloud.revision = result.revision;
      if (result.notificationStatus === "failed") {
        setConnectionStatus("connected", "Dados salvos, mas não foi possível enviar a notificação. Confira a configuração Firebase no servidor.");
      }
      saveLocalCache();
      return true;
    } catch (error) {
      if (error instanceof CloudRequestError && error.status === 409) {
        showToast("Outro aparelho salvou primeiro. Carreguei os dados atualizados; confira e tente novamente.", true);
        setTimeout(() => refreshAfterConflict(), 0);
      } else if (error instanceof CloudRequestError && error.status === 401) {
        expireCloudSession();
      } else {
        console.error("Não foi possível sincronizar as alterações com o servidor.", error);
        setConnectionStatus("blocked", "Servidor indisponível. O modo de edição ficará pausado para evitar dados divergentes; tente novamente em instantes.");
        showToast(error.message || "Não foi possível salvar no servidor. Seus dados não foram alterados.", true);
      }
      return false;
    } finally {
      cloud.saving = false;
    }
  }
  if (cloud.mode !== "local") return false;
  return saveLocalCache();
}

function validateCloudState(value) {
  if (!value || !Array.isArray(value.accounts) || !Array.isArray(value.transactions)) {
    throw new Error("O servidor retornou um extrato com formato inválido.");
  }
  const accountsById = new Map(DEFAULT_ACCOUNTS.map((account) => [account.id, account]));
  const accounts = value.accounts.map((account) => {
    if (!account || typeof account !== "object" || typeof account.id !== "string") {
      throw new Error("O servidor retornou um cartão inválido.");
    }
    const fallback = accountsById.get(account.id);
    const custom = account.custom === true;
    if (!fallback && (!custom || !/^card-[\da-f-]{36}$/i.test(account.id))) {
      throw new Error("O servidor retornou um cartão desconhecido.");
    }
    const normalized = normalizeAccount(account, fallback || null, custom);
    if (!normalized) throw new Error("O servidor retornou um cartão sem nome.");
    return normalized;
  });
  if (accounts.length < 1 || accounts.length > 100) {
    throw new Error("O servidor retornou uma quantidade inválida de cartões.");
  }
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length ||
      new Set(accounts.map((account) => account.name.toLocaleLowerCase("pt-BR"))).size !== accounts.length) {
    throw new Error("O servidor retornou cartões duplicados.");
  }
  const validAccountIds = new Set(accounts.map((account) => account.id));
  const transactions = value.transactions.map((transaction) => {
    if (!transaction || typeof transaction !== "object" ||
        typeof transaction.id !== "string" || !/^[\da-f-]{36}$/i.test(transaction.id) ||
        !validAccountIds.has(transaction.accountId) ||
        !["expense", "purchase"].includes(transaction.kind) ||
        typeof transaction.description !== "string" ||
        !transaction.description.trim() ||
        !Number.isFinite(transaction.amount) || transaction.amount <= 0 ||
        !isValidDate(transaction.date)) {
      throw new Error("O servidor retornou uma movimentação inválida.");
    }
    return { ...transaction, description: transaction.description.trim() };
  });
  if (new Set(transactions.map((transaction) => transaction.id)).size !== transactions.length) {
    throw new Error("O servidor retornou movimentações duplicadas.");
  }
  return { accounts, transactions };
}

function comparableState(value) {
  const stateToCompare = validateCloudState(value);
  return JSON.stringify({
    accounts: stateToCompare.accounts
      .map(({ id, name, kind, openingBalance, dailyLimit, lastFourDigits, custom }) =>
        ({ id, name, kind, openingBalance, dailyLimit, lastFourDigits, custom }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    transactions: [...stateToCompare.transactions].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function preserveLocalBackup() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && !localStorage.getItem(`${STORAGE_KEY}-before-sync`)) {
      localStorage.setItem(`${STORAGE_KEY}-before-sync`, saved);
    }
  } catch (error) {
    console.error("Não foi possível preservar uma cópia local antes da sincronização.", error);
  }
}

function applyRemoteState(response, { preserveLocal = false } = {}) {
  const remoteState = validateCloudState(response.state);
  if (preserveLocal && comparableState(state) !== comparableState(remoteState)) {
    preserveLocalBackup();
    showToast("Os dados do servidor foram carregados. Uma cópia anterior deste aparelho foi preservada localmente.");
  }
  state = remoteState;
  cloud.revision = response.revision;
  cloud.settingsDirty = false;
  if (!saveLocalCache()) {
    showToast("Os dados foram sincronizados com o servidor, mas não foi possível atualizar a cópia local.", true);
  }
  renderAll();
  setConnectionStatus("connected");
}

async function initializeRemoteState(response) {
  if (response.revision !== 0) {
    throw new Error("O servidor retornou uma revisão vazia inesperada.");
  }
  const migratingExistingData = localStorage.getItem(STORAGE_KEY) !== null;
  let result;
  try {
    result = await apiRequest("state", {
      method: "PUT",
      body: JSON.stringify({ revision: response.revision, state }),
    });
  } catch (error) {
    if (!(error instanceof CloudRequestError) || error.status !== 409) throw error;
    result = await apiRequest("state");
    if (!result.state) throw error;
    applyRemoteState(result, { preserveLocal: true });
    showToast("Outro aparelho preparou primeiro os dados compartilhados. Carreguei a versão do servidor.");
    return;
  }
  state = validateCloudState(result.state);
  cloud.revision = result.revision;
  if (!saveLocalCache()) {
    showToast("Os dados estão no servidor, mas a cópia local não pôde ser atualizada.", true);
  }
  renderAll();
  setConnectionStatus("connected");
  showToast(migratingExistingData
    ? "Os dados existentes deste aparelho foram enviados ao servidor."
    : "Armazenamento compartilhado preparado. Os dois aparelhos já podem sincronizar.");
}

function showLoginDialog() {
  const dialog = $("#login-dialog");
  if (!dialog.open) dialog.showModal();
  $("#login-password").focus();
}

function expireCloudSession() {
  if (cloud.pollTimer) clearInterval(cloud.pollTimer);
  cloud.pollTimer = null;
  cloud.accessToken = "";
  sessionStorage.removeItem("meu_pluxee_session_token");
  setConnectionStatus("auth-required", "Sua sessão expirou. Entre novamente para sincronizar os dados.");
  apiRequest("session")
    .then((result) => {
      cloud.csrfToken = result.csrfToken;
      showLoginDialog();
    })
    .catch((error) => {
      console.error("Não foi possível renovar a sessão do aplicativo.", error);
      showToast("Não foi possível renovar a sessão. Atualize a página e tente novamente.", true);
    });
}

async function connectRemoteState() {
  try {
    const result = await apiRequest("state");
    if (result.state === null) {
      await initializeRemoteState(result);
      return;
    }
    const hasLocalData = localStorage.getItem(STORAGE_KEY) !== null;
    applyRemoteState(result, { preserveLocal: hasLocalData && cloud.revision === 0 });
  } catch (error) {
    if (error instanceof CloudRequestError && error.status === 401) {
      expireCloudSession();
      return;
    }
    setConnectionStatus("blocked", error.message || "Não foi possível consultar o servidor.");
    console.error("Não foi possível carregar os dados do servidor.", error);
    showToast(error.message || "Não foi possível carregar os dados do servidor.", true);
  }
}

function startCloudPolling() {
  if (cloud.pollTimer) clearInterval(cloud.pollTimer);
  cloud.polling = true;
  cloud.pollTimer = setInterval(() => {
    if (cloud.polling) syncRemoteState();
  }, 5000);
}

async function syncRemoteState({ force = false } = {}) {
  if (cloud.syncing || cloud.saving || !["connected", "blocked"].includes(cloud.mode)) return;
  if (!force && (cloud.settingsDirty || $("#entry-dialog").open || $("#card-dialog").open || $("#login-dialog").open)) return;
  cloud.syncing = true;
  try {
    const result = await apiRequest("state", { revision: cloud.revision });
    if (result.unchanged === true) {
      setConnectionStatus("connected");
      cloud.polling = true;
      return;
    }
    if (result.revision !== cloud.revision || result.state === null) {
      if (result.state === null) {
        await initializeRemoteState(result);
      } else {
        applyRemoteState(result);
      }
    } else {
      setConnectionStatus("connected");
    }
    cloud.polling = true;
  } catch (error) {
    if (error instanceof CloudRequestError && error.status === 401) {
      expireCloudSession();
      cloud.polling = false;
    } else {
      setConnectionStatus("blocked", "Servidor indisponível. As alterações estão pausadas para evitar dados divergentes; tentando reconectar.");
      console.error("Não foi possível atualizar os dados compartilhados.", error);
    }
  } finally {
    cloud.syncing = false;
  }
}

async function refreshAfterConflict() {
  if ($("#entry-dialog").open) $("#entry-dialog").close();
  if ($("#card-dialog").open) $("#card-dialog").close();
  cloud.settingsDirty = false;
  await syncRemoteState({ force: true });
}

async function initializeCloud() {
  if (window.location.protocol === "file:" || document.documentElement.dataset.storageMode === "local") {
    setConnectionStatus("local");
    return;
  }
  setConnectionStatus("blocked", "Conectando ao armazenamento seguro do servidor…");
  try {
    cloud.accessToken = sessionStorage.getItem("meu_pluxee_session_token") || "";
    const session = await apiRequest("session");
    cloud.csrfToken = session.csrfToken;
    if (!session.authenticated) {
      cloud.accessToken = "";
      sessionStorage.removeItem("meu_pluxee_session_token");
      setConnectionStatus("auth-required", "Entre com sua senha para acessar os dados compartilhados.");
      showLoginDialog();
      return;
    }
    await connectRemoteState();
    if (cloud.mode === "connected") startCloudPolling();
  } catch (error) {
    setConnectionStatus("blocked", error.message || "Não foi possível conectar ao servidor. O modo de edição está pausado.");
    console.error("Não foi possível inicializar a conexão com o servidor.", error);
    showToast(error.message || "Não foi possível conectar ao servidor.", true);
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const submitButton = $("#login-submit");
  const errorMessage = $("#login-error");
  submitButton.disabled = true;
  errorMessage.hidden = true;
  try {
    const result = await apiRequest("login", {
      method: "POST",
      body: JSON.stringify({ password: $("#login-password").value }),
    });
    cloud.accessToken = result.accessToken;
    sessionStorage.setItem("meu_pluxee_session_token", cloud.accessToken);
    cloud.csrfToken = result.csrfToken;
    $("#login-form").reset();
    $("#login-dialog").close();
    await connectRemoteState();
    if (cloud.mode === "connected") startCloudPolling();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "Não foi possível entrar.";
    errorMessage.hidden = false;
    $("#login-password").select();
  } finally {
    submitButton.disabled = false;
  }
}

async function handleLogout() {
  $("#logout-button").disabled = true;
  try {
    await apiRequest("logout", { method: "POST" });
    cloud.accessToken = "";
    sessionStorage.removeItem("meu_pluxee_session_token");
    if (cloud.pollTimer) clearInterval(cloud.pollTimer);
    cloud.pollTimer = null;
    cloud.polling = false;
    const session = await apiRequest("session");
    cloud.csrfToken = session.csrfToken;
    setConnectionStatus("auth-required", "Entre para consultar os dados compartilhados.");
    showLoginDialog();
  } catch (error) {
    showToast(error.message || "Não foi possível encerrar a sessão.", true);
  } finally {
    $("#logout-button").disabled = false;
  }
}

function showToast(message, isError = false) {
  toastElement ||= $("#toast");
  if (!toastElement) return;
  toastElement.textContent = message;
  toastElement.classList.toggle("is-error", isError);
  toastElement.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove("is-visible"), 3500);
}

function accountFor(id) {
  return state.accounts.find((account) => account.id === id);
}

function accountBalance(account) {
  return account.openingBalance + state.transactions.reduce((balance, transaction) => {
    if (transaction.accountId !== account.id) return balance;
    return balance + (transaction.kind === "purchase" ? transaction.amount : -transaction.amount);
  }, 0);
}

function transactionsForMonth(date = currentMonthString()) {
  return state.transactions.filter((transaction) => transaction.date.startsWith(date));
}

function escapeCurrency(amount) {
  return currency.format(amount);
}

function getAccountSymbol(account) {
  return account.kind === "meal" ? "♨" : "▤";
}

function renderTodayLabel() {
  const today = new Date();
  const text = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(today);
  $("#today-label").textContent = text.charAt(0).toUpperCase() + text.slice(1);
}

function renderSummary() {
  const monthTransactions = transactionsForMonth();
  const monthExpenses = monthTransactions.filter((transaction) => transaction.kind === "expense");
  const monthPurchases = monthTransactions.filter((transaction) => transaction.kind === "purchase");
  const today = localDateString();
  const todayExpenses = state.transactions.filter((transaction) => transaction.kind === "expense" && transaction.date === today);
  const totalLimit = state.accounts.reduce((sum, account) => sum + account.dailyLimit, 0);
  const totalBalance = state.accounts.reduce((sum, account) => sum + accountBalance(account), 0);
  const sumAmounts = (transactions) => transactions.reduce((sum, transaction) => sum + transaction.amount, 0);

  $("#total-balance").textContent = escapeCurrency(totalBalance);
  $("#month-spent").textContent = escapeCurrency(sumAmounts(monthExpenses));
  $("#month-purchases").textContent = escapeCurrency(sumAmounts(monthPurchases));
  $("#today-spent").textContent = escapeCurrency(sumAmounts(todayExpenses));
  $("#account-count-caption").textContent = `somando ${state.accounts.length} benefício${state.accounts.length === 1 ? "" : "s"}`;
  $("#today-limit-caption").textContent = totalLimit > 0
    ? `limite diário total de ${escapeCurrency(totalLimit)}`
    : "configure seus limites diários";
}

function renderAccounts() {
  const today = localDateString();
  $("#accounts-grid").innerHTML = state.accounts.map((account) => {
    const spentToday = state.transactions.reduce((sum, transaction) =>
      transaction.accountId === account.id && transaction.kind === "expense" && transaction.date === today
        ? sum + transaction.amount
        : sum, 0);
    const limit = account.dailyLimit;
    const ratio = limit > 0 ? (spentToday / limit) * 100 : 0;
    const width = limit > 0 ? Math.min(ratio, 100) : 0;
    const progressClass = ratio >= 100 && limit > 0 ? "is-over" : ratio >= 75 ? "is-warning" : "";
    const remainingText = limit <= 0
      ? "Defina um limite diário nas configurações"
      : ratio > 100
        ? `<span class="over-limit">${escapeCurrency(spentToday - limit)} acima do limite</span>`
        : `${escapeCurrency(Math.max(0, limit - spentToday))} restantes hoje`;
    return `
      <article class="account-card">
        <div class="account-top">
          <span class="account-symbol ${account.kind}" aria-hidden="true">${getAccountSymbol(account)}</span>
          <div class="account-name"><strong>${escapeHTML(account.name)}</strong><span>${escapeHTML(account.detail)}</span></div>
        </div>
        <div class="account-balance-label">Saldo disponível</div>
        <strong class="account-balance">${escapeCurrency(accountBalance(account))}</strong>
        <div class="progress-header"><span>Gasto de hoje</span><span>${escapeCurrency(spentToday)}${limit > 0 ? ` de ${escapeCurrency(limit)}` : ""}</span></div>
        <div class="progress-track" role="progressbar" aria-label="Limite diário de ${escapeHTML(account.name)}" aria-valuemin="0" aria-valuemax="${limit || 0}" aria-valuenow="${spentToday}">
          <div class="progress-fill ${progressClass}" style="width:${width}%"></div>
        </div>
        <div class="account-limit-note"><span>${remainingText}</span><span>${limit > 0 ? `${Math.min(Math.round(ratio), 999)}%` : "Sem limite"}</span></div>
        <button class="text-button account-statement-link" type="button" data-account-statement="${escapeHTML(account.id)}">Ver extrato <span aria-hidden="true">→</span></button>
      </article>`;
  }).join("");
}

function accountChip(account) {
  const mealClass = account.kind === "meal" ? "meal" : "";
  return `<span class="account-chip"><span class="account-chip-dot ${mealClass}" aria-hidden="true"></span>${escapeHTML(account.name)}</span>`;
}

function transactionRow(transaction, includeDelete = false) {
  const account = accountFor(transaction.accountId);
  const isPurchase = transaction.kind === "purchase";
  const date = new Date(`${transaction.date}T12:00:00`);
  const formattedDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(date);
  return `<tr>
    <td><span class="transaction-description"><span class="transaction-icon ${transaction.kind}" aria-hidden="true">${isPurchase ? "＋" : "↗"}</span>${escapeHTML(transaction.description)}</span></td>
    <td>${accountChip(account)}</td>
    <td>${formattedDate}</td>
    <td><span class="type-badge ${isPurchase ? "purchase" : ""}">${isPurchase ? "Compra do mês" : "Despesa"}</span></td>
    <td class="amount-column ${isPurchase ? "purchase-amount" : ""}">${isPurchase ? "+" : "−"}${escapeCurrency(transaction.amount)}</td>
    ${includeDelete ? `<td><button class="delete-entry" type="button" data-delete-id="${escapeHTML(transaction.id)}" aria-label="Apagar lançamento ${escapeHTML(transaction.description)}" title="Apagar lançamento">×</button></td>` : ""}
  </tr>`;
}

function renderRecentTransactions() {
  const recent = [...transactionsForMonth()].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 5);
  $("#recent-transactions").innerHTML = recent.map((transaction) => transactionRow(transaction)).join("");
  $("#recent-empty").hidden = recent.length > 0;
  $(".table-card:has(#recent-transactions) .table-wrap").hidden = recent.length === 0;
}

function renderActivity() {
  const monthFilter = $("#month-filter");
  const accountFilter = $("#account-filter");
  if (!monthFilter.value) monthFilter.value = currentMonthString();
  const transactions = [...state.transactions]
    .filter((transaction) => transaction.date.startsWith(monthFilter.value))
    .filter((transaction) => accountFilter.value === "all" || transaction.accountId === accountFilter.value)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const sum = (kind) => transactions
    .filter((transaction) => transaction.kind === kind)
    .reduce((total, transaction) => total + transaction.amount, 0);
  const selectedAccounts = accountFilter.value === "all"
    ? state.accounts
    : state.accounts.filter((account) => account.id === accountFilter.value);
  $("#statement-expenses").textContent = escapeCurrency(sum("expense"));
  $("#statement-purchases").textContent = escapeCurrency(sum("purchase"));
  $("#statement-balance").textContent = escapeCurrency(selectedAccounts.reduce((total, account) => total + accountBalance(account), 0));
  $("#all-transactions").innerHTML = transactions.map((transaction) => transactionRow(transaction, true)).join("");
  $("#activity-empty").hidden = transactions.length > 0;
  $(".table-card:has(#all-transactions) .table-wrap").hidden = transactions.length === 0;
}

function renderSettings() {
  $("#settings-grid").innerHTML = state.accounts.map((account) => `
    <article class="settings-card">
      <div class="settings-card-title">
        <span class="account-symbol ${account.kind}" aria-hidden="true">${getAccountSymbol(account)}</span>
        <div class="settings-card-name"><strong>${escapeHTML(account.name)}</strong><small>${escapeHTML(account.detail)}</small></div>
      </div>
      <label class="settings-field">
        <span>Nome de identificação</span>
        <input class="field-input" type="text" maxlength="35" name="name-${escapeHTML(account.id)}" value="${escapeHTML(account.name)}" required>
      </label>
      ${account.custom ? `<label class="settings-field">
        <span>Tipo de benefício</span>
        <select class="field-input" name="kind-${escapeHTML(account.id)}" required>
          <option value="food" ${account.kind === "food" ? "selected" : ""}>Alimentação</option>
          <option value="meal" ${account.kind === "meal" ? "selected" : ""}>Refeição</option>
        </select>
      </label>` : ""}
      <label class="settings-field">
        <span>Últimos 4 dígitos (opcional)</span>
        <input class="field-input" type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" name="last-four-${escapeHTML(account.id)}" value="${escapeHTML(account.lastFourDigits)}" placeholder="0000" autocomplete="off">
      </label>
      <label class="settings-field">
        <span>Saldo inicial do cartão</span>
        <div class="settings-input"><span>R$</span><input type="number" min="0" max="1000000000" step="0.01" name="balance-${account.id}" value="${account.openingBalance.toFixed(2)}" required></div>
        <small>Saldo atual do cartão no início do controle.</small>
      </label>
      <label class="settings-field">
        <span>Limite que posso gastar por dia</span>
        <div class="settings-input"><span>R$</span><input type="number" min="0" max="1000000000" step="0.01" name="limit-${account.id}" value="${account.dailyLimit.toFixed(2)}" required></div>
        <small>Usado para comparar com as despesas diárias.</small>
      </label>
      <div class="settings-card-actions">
        <button class="button button-secondary" type="button" data-voice-card="${escapeHTML(account.id)}">🎙 Áudio</button>
        <button class="button button-primary" type="button" data-save-card="${escapeHTML(account.id)}">Salvar</button>
        <button class="button button-danger-ghost" type="button" data-delete-card="${escapeHTML(account.id)}">Excluir</button>
      </div>
    </article>`).join("");
    cloud.settingsDirty = false;
}

function restorePendingSettings(formData, excludedAccountId = null) {
  let hasPendingChanges = false;
  for (const account of state.accounts) {
    if (account.id === excludedAccountId) continue;
    const fields = [
      [`name-${account.id}`, account.name],
      [`last-four-${account.id}`, account.lastFourDigits],
      [`balance-${account.id}`, account.openingBalance.toFixed(2)],
      [`limit-${account.id}`, account.dailyLimit.toFixed(2)],
    ];
    if (account.custom) fields.push([`kind-${account.id}`, account.kind]);
    for (const [name, savedValue] of fields) {
      const field = $("#settings-form").elements.namedItem(name);
      const formValue = formData.get(name);
      if (!field || formValue === null) continue;
      field.value = formValue;
      if (String(formValue) !== savedValue) hasPendingChanges = true;
    }
  }
  cloud.settingsDirty = hasPendingChanges;
}

function parsePortugueseNumberWords(value) {
  const numberWords = {
    zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
    seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
    treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16,
    dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
    quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80,
    noventa: 90, cem: 100, cento: 100, duzentos: 200, trezentos: 300,
    quatrocentos: 400, quinhentos: 500, seiscentos: 600, setecentos: 700,
    oitocentos: 800, novecentos: 900,
  };
  const normalized = value.toLocaleLowerCase("pt-BR").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\br\$\s*/g, "").trim();
  if (/^\d[\d.,\s]*$/.test(normalized)) {
    let numericValue = normalized.replace(/\s/g, "");
    if (numericValue.includes(",") && numericValue.includes(".")) {
      numericValue = numericValue.lastIndexOf(",") > numericValue.lastIndexOf(".")
        ? numericValue.replace(/\./g, "").replace(",", ".")
        : numericValue.replace(/,/g, "");
    } else if (numericValue.includes(",")) {
      numericValue = numericValue.replace(/\./g, "").replace(",", ".");
    }
    const amount = Number(numericValue);
    return Number.isFinite(amount) ? amount : null;
  }

  const parts = normalized.split(/\s+virgula\s+/);
  const parseWords = (text) => {
    const tokens = text.split(/[\s-]+/).filter((token) => token && token !== "e");
    let total = 0;
    let group = 0;
    for (const token of tokens) {
      if (numberWords[token] !== undefined) {
        group += numberWords[token];
      } else if (token === "mil") {
        total += (group || 1) * 1000;
        group = 0;
      } else if (token === "milhao" || token === "milhoes") {
        total += (group || 1) * 1_000_000;
        group = 0;
      } else {
        return null;
      }
    }
    return total + group;
  };
  const wholeText = parts[0].replace(/\b(?:reais?|r\$)\b/g, "").trim();
  const whole = parseWords(wholeText);
  if (whole === null) return null;
  if (parts.length === 1) return whole;
  const decimal = parseWords(parts[1].replace(/\b(?:reais?|r\$)\b/g, "").trim());
  if (decimal === null) return null;
  return whole + decimal / (10 ** String(decimal).length);
}

function parseVoiceCardCommand(transcript) {
  let normalized = "";
  const sourceOffsets = [];
  for (let index = 0; index < transcript.length;) {
    const character = String.fromCodePoint(transcript.codePointAt(index));
    const end = index + character.length;
    const plainCharacter = character.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
    normalized += plainCharacter;
    for (let offset = 0; offset < plainCharacter.length; offset += 1) {
      sourceOffsets.push({ start: index, end });
    }
    index = end;
  }
  const labels = [...normalized.matchAll(
    /\bnome(?:\s+de\s+identificacao)?\b|\btipo(?:\s+de\s+beneficio)?\b|\bbeneficio\b|\bultimos(?:\s+(?:quatro|4))?\s+digitos\b|\bfinal(?:\s+do\s+cartao)?\b|\bsaldo(?:\s+inicial)?\b|\blimite(?:\s+diario|\s+por\s+dia)?\b/g,
  )];
  const values = {};
  labels.forEach((label, index) => {
    const start = label.index + label[0].length;
    const end = labels[index + 1]?.index ?? normalized.length;
    const sourceStart = sourceOffsets[start]?.start ?? transcript.length;
    const sourceEnd = sourceOffsets[end - 1]?.end ?? transcript.length;
    const spokenValue = transcript.slice(sourceStart, sourceEnd)
      .replace(/^\s*(?:e|de|para)\s+/, "")
      .replace(/\s+e\s*$/, "")
      .trim()
      .replace(/[.!?,;]+$/g, "")
      .trim();
    const fieldLabel = label[0];
    if (fieldLabel.startsWith("nome")) {
      const name = spokenValue.replace(/^(?:e|de|para|do cartao|é|eh)\s+/i, "").trim();
      if (name && name.length <= 35) values.name = name;
      return;
    }
    if (fieldLabel.startsWith("tipo") || fieldLabel === "beneficio") {
      const normalizedKind = spokenValue.toLocaleLowerCase("pt-BR").normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "").replace(/^(?:é|eh|do tipo|de)\s+/, "").trim();
      if (/\b(?:refeicao|meal)\b/.test(normalizedKind)) values.kind = "meal";
      else if (/\b(?:alimentacao|food)\b/.test(normalizedKind)) values.kind = "food";
      return;
    }
    if (fieldLabel.startsWith("ultimos") || fieldLabel.startsWith("final")) {
      const digits = spokenValue.replace(/^(?:do cartao|numero|final)\s+/i, "").trim();
      const spokenDigits = digits.split(/[\s,.-]+/).filter(Boolean).map((word) => ({
        zero: "0", um: "1", uma: "1", dois: "2", duas: "2", tres: "3",
        quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8", nove: "9",
      })[word.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "")] ?? word).join("");
      if (/^\d{4}$/.test(spokenDigits)) values.lastFourDigits = spokenDigits;
      return;
    }
    const amount = parsePortugueseNumberWords(spokenValue);
    if (amount === null || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) return;
    const field = fieldLabel.startsWith("saldo") ? "balance" : "limit";
    values[field] = Math.round(amount * 100) / 100;
  });
  return values;
}

function stopVoiceRecognition() {
  if (!voiceRecognition) return;
  voiceRecognition.onresult = null;
  voiceRecognition.onerror = null;
  voiceRecognition.onend = null;
  voiceRecognition.stop();
  voiceRecognition = null;
}

function startCardVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("#voice-status").textContent = "Este navegador não oferece reconhecimento de voz. Tente usar Chrome ou Edge.";
    return;
  }
  if (!window.isSecureContext && window.location.protocol !== "file:") {
    $("#voice-status").textContent = "Para usar o microfone, abra o aplicativo em uma conexão HTTPS.";
    return;
  }

  stopVoiceRecognition();
  $("#voice-transcript").value = "";
  $("#voice-status").textContent = "Aguardando permissão do microfone…";
  const recognition = new SpeechRecognition();
  voiceRecognition = recognition;
  recognition.lang = "pt-BR";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    $("#voice-status").textContent = "Ouvindo… diga o nome, tipo, últimos dígitos, saldo e/ou limite que deseja alterar.";
  };
  recognition.onresult = (event) => {
    $("#voice-transcript").value = event.results[0][0].transcript;
    $("#voice-status").textContent = "Confira a transcrição. Corrija o texto se necessário antes de aplicar.";
  };
  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Permita o acesso ao microfone nas configurações do navegador.",
      "service-not-allowed": "O serviço de reconhecimento de voz não está disponível neste navegador.",
      "audio-capture": "Nenhum microfone foi encontrado ou ele está indisponível.",
      "no-speech": "Nenhuma fala foi detectada. Tente novamente.",
      network: "O reconhecimento de voz falhou. Verifique a conexão e tente novamente.",
      aborted: "A captura de voz foi cancelada.",
    };
    $("#voice-status").textContent = messages[event.error] || "Não foi possível reconhecer a fala. Tente novamente.";
  };
  recognition.onend = () => {
    if (voiceRecognition === recognition) voiceRecognition = null;
  };
  try {
    recognition.start();
  } catch (error) {
    voiceRecognition = null;
    console.error("Não foi possível iniciar o reconhecimento de voz.", error);
    $("#voice-status").textContent = "Não foi possível iniciar o microfone. Feche esta janela e tente novamente.";
  }
}

function openCardVoiceUpdate(id) {
  if (!accountFor(id)) return;
  voiceAccountId = id;
  $("#voice-title").textContent = `Atualizar ${accountFor(id).name} por áudio`;
  $("#voice-transcript").value = "";
  $("#voice-dialog").showModal();
  startCardVoiceRecognition();
}

function applyVoiceCardUpdate() {
  const values = parseVoiceCardCommand($("#voice-transcript").value);
  if (Object.keys(values).length === 0) {
    $("#voice-status").textContent = "Não encontrei campos reconhecidos. Exemplo: “nome Cartão mercado, tipo alimentação, últimos quatro dígitos 1234, saldo inicial quinhentos e limite diário quarenta”.";
    return;
  }
  if (!accountFor(voiceAccountId)) {
    $("#voice-status").textContent = "Este cartão não está mais disponível. Feche e tente novamente.";
    return;
  }
  const fields = [];
  if (values.balance !== undefined) fields.push([`balance-${voiceAccountId}`, values.balance]);
  if (values.limit !== undefined) fields.push([`limit-${voiceAccountId}`, values.limit]);
  if (values.name !== undefined) fields.push([`name-${voiceAccountId}`, values.name]);
  if (values.lastFourDigits !== undefined) fields.push([`last-four-${voiceAccountId}`, values.lastFourDigits]);
  if (values.kind !== undefined) fields.push([`kind-${voiceAccountId}`, values.kind]);
  let unavailableFields = 0;
  for (const [name, value] of fields) {
    const input = $("#settings-form").elements.namedItem(name);
    if (!input) {
      unavailableFields += 1;
      continue;
    }
    input.value = typeof value === "number" ? value.toFixed(2) : value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  stopVoiceRecognition();
  $("#voice-dialog").close();
  showToast(unavailableFields
    ? "Campos disponíveis atualizados. O tipo de benefício não pode ser alterado nos cartões padrão."
    : "Campos mencionados atualizados. Confira-os e toque em Salvar para gravar.");
}

function renderAccountSelects() {
  const selectedAccount = $("#account-filter").value;
  const options = state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("");
  $("#entry-account").innerHTML = options;
  $("#account-filter").innerHTML = `<option value="all">Todas as contas</option>${options}`;
  if (selectedAccount === "all" || state.accounts.some((account) => account.id === selectedAccount)) {
    $("#account-filter").value = selectedAccount || "all";
  }
}

function renderAll() {
  renderSummary();
  renderAccounts();
  renderRecentTransactions();
  renderSettings();
  renderAccountSelects();
  renderActivity();
}

function navigateTo(viewName) {
  const titles = { overview: "Visão geral", activity: "Extratos", settings: "Configurações" };
  $$(".view").forEach((view) => {
    const active = view.id === `${viewName}-view`;
    view.hidden = !active;
    view.classList.toggle("is-visible", active);
  });
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $("#breadcrumb-current").textContent = titles[viewName];
}

function updateEntryKind(kind) {
  $("#entry-kind").value = kind;
  $$(".kind-option").forEach((button) => button.classList.toggle("is-selected", button.dataset.kind === kind));
  const purchase = kind === "purchase";
  $("#dialog-title").textContent = purchase ? "Registrar compra do mês" : "Registrar gasto";
  $("#entry-hint").textContent = purchase
    ? "A compra mensal aumenta o saldo do cartão e não entra no cálculo do limite diário."
    : "A despesa entra no total gasto de hoje e reduz o saldo da conta.";
  $("#entry-description").placeholder = purchase ? "Ex.: crédito mensal" : "Ex.: almoço, mercado";
}

function openEntryForm(kind) {
  const form = $("#entry-form");
  form.reset();
  $("#entry-date").value = localDateString();
  updateEntryKind(kind);
  $("#entry-dialog").showModal();
  $("#entry-description").focus();
}

async function handleEntrySubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const amount = Number(formData.get("amount"));
  const date = String(formData.get("date"));
  const accountId = String(formData.get("accountId"));
  const description = String(formData.get("description")).trim();
  if (!Number.isFinite(amount) || amount <= 0 || !accountFor(accountId) || !description || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showToast("Confira a descrição, o valor, a data e a conta.", true);
    return;
  }
  const transaction = {
    id: crypto.randomUUID(),
    accountId,
    kind: String(formData.get("kind")),
    description,
    amount: Math.round(amount * 100) / 100,
    date,
  };
  if (transaction.kind === "expense" && transaction.amount > accountBalance(accountFor(accountId))) {
    const confirmed = window.confirm("Este gasto é maior que o saldo calculado para esta conta. Deseja registrá-lo mesmo assim?");
    if (!confirmed) return;
  }
  state.transactions.push(transaction);
  if (!await saveData()) {
    state.transactions.pop();
    return;
  }
  $("#entry-dialog").close();
  renderAll();
  showToast(transaction.kind === "purchase" ? "Compra do mês registrada." : "Gasto registrado.");
}

function openCardForm() {
  $("#card-form").reset();
  $("#card-dialog").showModal();
  $("#card-name").focus();
}

async function handleCardSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const name = String(formData.get("name")).trim();
  const kind = String(formData.get("kind"));
  const lastFourDigits = String(formData.get("lastFourDigits")).trim();
  if (!name || !["food", "meal"].includes(kind) || (lastFourDigits && !/^\d{4}$/.test(lastFourDigits))) {
    showToast("Confira o nome, o tipo de benefício e os quatro últimos dígitos.", true);
    return;
  }
  if (state.accounts.some((account) => account.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
    showToast("Já existe um cartão com esse nome. Escolha outro nome para identificá-lo.", true);
    return;
  }
  const account = normalizeAccount({
    id: `card-${crypto.randomUUID()}`,
    name,
    kind,
    lastFourDigits,
    openingBalance: 0,
    dailyLimit: 0,
  }, null, true);
  state.accounts.push(account);
  if (!await saveData()) {
    state.accounts.pop();
    return;
  }
  $("#card-dialog").close();
  renderAll();
  showToast("Cartão cadastrado. Ajuste o saldo e o limite diário em Configurações.");
}

function updatedAccountFromForm(account, formData) {
  const name = String(formData.get(`name-${account.id}`) || "").trim();
  const lastFourDigits = String(formData.get(`last-four-${account.id}`) || "").trim();
  const kind = account.custom ? String(formData.get(`kind-${account.id}`)) : account.kind;
  const openingBalanceValue = String(formData.get(`balance-${account.id}`) ?? "").trim();
  const dailyLimitValue = String(formData.get(`limit-${account.id}`) ?? "").trim();
  const openingBalance = Number(openingBalanceValue);
  const dailyLimit = Number(dailyLimitValue);
  if (!name || name.length > 35 || !["food", "meal"].includes(kind) || (lastFourDigits && !/^\d{4}$/.test(lastFourDigits)) ||
      !openingBalanceValue || !Number.isFinite(openingBalance) || openingBalance < 0 || openingBalance > 1_000_000_000 ||
      !dailyLimitValue || !Number.isFinite(dailyLimit) || dailyLimit < 0 || dailyLimit > 1_000_000_000) {
    return null;
  }
  return normalizeAccount({ ...account, name, kind, lastFourDigits, openingBalance, dailyLimit }, account, account.custom);
}

async function saveAccountSettings(id) {
  const accountIndex = state.accounts.findIndex((account) => account.id === id);
  if (accountIndex < 0) return;
  const formData = new FormData($("#settings-form"));
  const updatedAccount = updatedAccountFromForm(state.accounts[accountIndex], formData);
  if (!updatedAccount) {
    showToast("Confira o nome, os quatro últimos dígitos e os valores deste cartão.", true);
    return;
  }
  if (state.accounts.some((account, index) => {
    if (index === accountIndex) return false;
    const otherName = String(formData.get(`name-${account.id}`) ?? account.name).trim();
    return otherName.toLocaleLowerCase("pt-BR") === updatedAccount.name.toLocaleLowerCase("pt-BR");
  })) {
    showToast("Cada cartão precisa ter um nome de identificação diferente.", true);
    return;
  }
  const previousAccount = state.accounts[accountIndex];
  state.accounts[accountIndex] = updatedAccount;
  if (!await saveData()) {
    state.accounts[accountIndex] = previousAccount;
    return;
  }
  renderAll();
  restorePendingSettings(formData, id);
  showToast("Cartão salvo.");
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const updatedAccounts = state.accounts.map((account) => updatedAccountFromForm(account, formData));
  if (updatedAccounts.some((account) => account === null)) {
    showToast("Confira os nomes, os quatro últimos dígitos e os valores de todas as contas.", true);
    return;
  }
  if (new Set(updatedAccounts.map((account) => account.name.toLocaleLowerCase("pt-BR"))).size !== updatedAccounts.length) {
    showToast("Cada cartão precisa ter um nome de identificação diferente.", true);
    return;
  }
  const previousAccounts = state.accounts;
  state.accounts = updatedAccounts;
  if (!await saveData()) {
    state.accounts = previousAccounts;
    return;
  }
  renderAll();
  showToast("Configurações salvas.");
}

async function handleDeleteCard(id) {
  const account = accountFor(id);
  if (!account) return;
  if (state.accounts.length <= 1) {
    showToast("Mantenha pelo menos um cartão cadastrado.", true);
    return;
  }
  if (state.transactions.some((transaction) => transaction.accountId === id)) {
    showToast("Este cartão possui movimentações. Apague as movimentações do extrato antes de excluir o cartão.", true);
    return;
  }
  if (!window.confirm(`Excluir o cartão "${account.name}"?`)) return;
  const formData = new FormData($("#settings-form"));
  const accountIndex = state.accounts.findIndex((item) => item.id === id);
  const [removedAccount] = state.accounts.splice(accountIndex, 1);
  if (!await saveData()) {
    state.accounts.splice(accountIndex, 0, removedAccount);
    return;
  }
  renderAll();
  restorePendingSettings(formData, id);
  showToast("Cartão excluído.");
}

async function handleDeleteTransaction(id) {
  const transactionIndex = state.transactions.findIndex((transaction) => transaction.id === id);
  if (transactionIndex < 0) return;
  const [transaction] = state.transactions.splice(transactionIndex, 1);
  if (!await saveData()) {
    state.transactions.splice(transactionIndex, 0, transaction);
    return;
  }
  renderAll();
  showToast("Lançamento apagado.");
}

function parseCsv(text) {
  const content = text.replace(/^\uFEFF/, "");
  const firstLine = content.split(/\r?\n/, 1)[0] || "";
  let delimiter = ";";
  let quote = false;
  let commas = 0;
  let semicolons = 0;
  for (let index = 0; index < firstLine.length; index += 1) {
    if (firstLine[index] === '"') {
      if (quote && firstLine[index + 1] === '"') index += 1;
      else quote = !quote;
    } else if (!quote && firstLine[index] === ",") commas += 1;
    else if (!quote && firstLine[index] === ";") semicolons += 1;
  }
  if (commas > semicolons) delimiter = ",";

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inQuotes) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
        quoteClosed = true;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field.length > 0 || quoteClosed) throw new CsvImportError("Há aspas fora do lugar no arquivo CSV.");
      inQuotes = true;
    } else if (character === delimiter) {
      row.push(field.trim());
      field = "";
      quoteClosed = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
      quoteClosed = false;
    } else {
      if (quoteClosed && !/\s/.test(character)) throw new CsvImportError("Há texto após uma aspa fechada no arquivo CSV.");
      if (!quoteClosed) field += character;
    }
  }
  if (inQuotes) throw new CsvImportError("Há um campo com aspas não fechadas no arquivo CSV.");
  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function normalizeCsvHeader(header) {
  return header.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function parseCsvDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isValidDate(value) ? value : null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const date = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return isValidDate(date) ? date : null;
}

function parseCsvAmount(value) {
  let normalized = value.replace(/R\$/gi, "").replace(/\s/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.lastIndexOf(",") > normalized.lastIndexOf(".")
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

function resolveCsvAccount(value) {
  const identifier = value.trim();
  const exactMatch = state.accounts.find((account) =>
    account.name.toLocaleLowerCase("pt-BR") === identifier.toLocaleLowerCase("pt-BR"));
  if (exactMatch) return exactMatch;
  const digits = identifier.replace(/\D/g, "");
  if (digits.length !== 4) return null;
  const matches = state.accounts.filter((account) => account.lastFourDigits === digits);
  return matches.length === 1 ? matches[0] : null;
}

function transactionFingerprint(transaction) {
  return [
    transaction.accountId,
    transaction.date,
    transaction.kind,
    transaction.amount.toFixed(2),
    transaction.description.trim().toLocaleLowerCase("pt-BR"),
  ].join("|");
}

async function importStatementCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new CsvImportError("O CSV precisa conter o cabeçalho e ao menos um lançamento.");
  if (rows.length > 5001) throw new CsvImportError("O arquivo excede o limite de 5.000 lançamentos por importação.");
  const headers = rows[0].map(normalizeCsvHeader);
  const columns = {
    date: headers.findIndex((header) => ["data", "date"].includes(header)),
    description: headers.findIndex((header) => ["descricao", "description"].includes(header)),
    amount: headers.findIndex((header) => ["valor", "amount"].includes(header)),
    kind: headers.findIndex((header) => ["tipo", "type"].includes(header)),
    account: headers.findIndex((header) => ["cartao", "card", "conta", "account"].includes(header)),
  };
  const missing = Object.entries(columns).filter(([, index]) => index < 0).map(([name]) => ({
    date: "data",
    description: "descrição",
    amount: "valor",
    kind: "tipo",
    account: "cartão",
  })[name]);
  if (missing.length) {
    throw new CsvImportError(`Colunas ausentes: ${missing.join(", ")}. Baixe o modelo CSV para ver o formato esperado.`);
  }

  const existing = new Set(state.transactions.map(transactionFingerprint));
  const imported = [];
  const errors = [];
  let duplicates = 0;
  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const description = row[columns.description] || "";
    const date = parseCsvDate(row[columns.date] || "");
    const amount = parseCsvAmount(row[columns.amount] || "");
    const account = resolveCsvAccount(row[columns.account] || "");
    const kindValue = normalizeCsvHeader(row[columns.kind] || "");
    const kind = ["despesa", "expense", "gasto"].includes(kindValue)
      ? "expense"
      : ["compra", "compradomes", "purchase", "credito", "credit"].includes(kindValue)
        ? "purchase"
        : null;
    if (!description || !date || !amount || !account || !kind) {
      const invalid = [
        !date && "data",
        !description && "descrição",
        !amount && "valor (deve ser maior que zero)",
        !kind && "tipo (despesa ou compra)",
        !account && "cartão (nome exato ou final único de 4 dígitos)",
      ].filter(Boolean);
      errors.push(`linha ${line}: ${invalid.join(", ")}`);
      return;
    }
    const transaction = {
      id: crypto.randomUUID(),
      accountId: account.id,
      kind,
      description: description.slice(0, 60),
      amount,
      date,
    };
    const fingerprint = transactionFingerprint(transaction);
    if (existing.has(fingerprint)) {
      duplicates += 1;
      return;
    }
    existing.add(fingerprint);
    imported.push(transaction);
  });
  if (errors.length) {
    throw new CsvImportError(`Nenhuma movimentação foi importada. ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? `; e mais ${errors.length - 3} linha(s) inválida(s)` : ""}.`);
  }
  if (imported.length === 0) {
    throw new CsvImportError(duplicates > 0
      ? `Todas as movimentações do arquivo já existem no extrato (${duplicates} duplicada(s)).`
      : "O CSV não contém movimentações para importar.");
  }
  const previousTransactions = state.transactions;
  state.transactions = [...state.transactions, ...imported];
  if (!await saveData()) {
    state.transactions = previousTransactions;
    return null;
  }
  renderAll();
  return { imported: imported.length, duplicates };
}

async function handleCsvFile(event) {
  const [file] = event.currentTarget.files;
  event.currentTarget.value = "";
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast("O arquivo excede o limite de 5 MB.", true);
    return;
  }
  try {
    const result = await importStatementCsv(await file.text());
    if (!result) return;
    showToast(`${result.imported} movimentação(ões) importada(s)${result.duplicates ? `; ${result.duplicates} duplicada(s) ignorada(s)` : ""}.`);
  } catch (error) {
    if (!(error instanceof CsvImportError)) console.error("Não foi possível importar o extrato CSV.", error);
    showToast(error instanceof Error ? error.message : "Não foi possível importar este arquivo CSV.", true);
  }
}

function downloadCsvTemplate() {
  const content = "\uFEFFdata;descricao;valor;tipo;cartao\r\n";
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "modelo-extrato-cartao.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Modelo baixado. Preencha os dados e use o nome exato do cartão.");
}

async function handleReset() {
  const confirmed = window.confirm("Tem certeza que deseja apagar todos os cartões, saldos, limites e extratos deste aplicativo e de todos os aparelhos sincronizados? Esta ação não pode ser desfeita.");
  if (!confirmed) return;
  const previousState = state;
  state = emptyState();
  if (!await saveData()) {
    state = previousState;
    return;
  }
  renderAll();
  showToast("Os dados deste aplicativo e dos aparelhos sincronizados foram apagados.");
}

function initialize() {
  toastElement = $("#toast");
  renderTodayLabel();
  $("#month-filter").value = currentMonthString();
  renderAll();

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => navigateTo(button.dataset.view)));
  $$("[data-go-view]").forEach((button) => button.addEventListener("click", () => navigateTo(button.dataset.goView)));
  $$("[data-open-form]").forEach((button) => button.addEventListener("click", () => openEntryForm(button.dataset.openForm)));
  $$("[data-open-card]").forEach((button) => button.addEventListener("click", openCardForm));
  $$(".kind-option").forEach((button) => button.addEventListener("click", () => updateEntryKind(button.dataset.kind)));
  $("#entry-form").addEventListener("submit", handleEntrySubmit);
  $("#card-form").addEventListener("submit", handleCardSubmit);
  $("#settings-form").addEventListener("submit", handleSettingsSubmit);
  $("#notification-toggle").addEventListener("click", togglePushNotifications);
  $("#settings-form").addEventListener("input", () => {
    cloud.settingsDirty = true;
  });
  $("#month-filter").addEventListener("change", renderActivity);
  $("#account-filter").addEventListener("change", renderActivity);
  $("#import-csv-button").addEventListener("click", () => $("#import-csv-file").click());
  $("#import-csv-file").addEventListener("change", handleCsvFile);
  $("#download-csv-template").addEventListener("click", downloadCsvTemplate);
  $("#all-transactions").addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-id]");
    if (deleteButton) handleDeleteTransaction(deleteButton.dataset.deleteId);
  });
  $("#settings-grid").addEventListener("click", (event) => {
    const voiceButton = event.target.closest("[data-voice-card]");
    if (voiceButton) {
      openCardVoiceUpdate(voiceButton.dataset.voiceCard);
      return;
    }
    const saveButton = event.target.closest("[data-save-card]");
    if (saveButton) {
      saveAccountSettings(saveButton.dataset.saveCard);
      return;
    }
    const deleteButton = event.target.closest("[data-delete-card]");
    if (deleteButton) handleDeleteCard(deleteButton.dataset.deleteCard);
  });
  $("#accounts-grid").addEventListener("click", (event) => {
    const statementButton = event.target.closest("[data-account-statement]");
    if (!statementButton) return;
    navigateTo("activity");
    $("#month-filter").value = currentMonthString();
    $("#account-filter").value = statementButton.dataset.accountStatement;
    renderActivity();
  });
  $("#reset-data").addEventListener("click", handleReset);
  $("#login-form").addEventListener("submit", handleLoginSubmit);
  $("#logout-button").addEventListener("click", handleLogout);
  $("#close-dialog").addEventListener("click", () => $("#entry-dialog").close());
  $("#cancel-dialog").addEventListener("click", () => $("#entry-dialog").close());
  $("#close-card-dialog").addEventListener("click", () => $("#card-dialog").close());
  $("#cancel-card-dialog").addEventListener("click", () => $("#card-dialog").close());
  $("#close-voice-dialog").addEventListener("click", () => {
    stopVoiceRecognition();
    $("#voice-dialog").close();
  });
  $("#cancel-voice-dialog").addEventListener("click", () => {
    stopVoiceRecognition();
    $("#voice-dialog").close();
  });
  $("#voice-retry").addEventListener("click", startCardVoiceRecognition);
  $("#voice-apply").addEventListener("click", applyVoiceCardUpdate);
  $("#voice-dialog").addEventListener("click", (event) => {
    if (event.target === $("#voice-dialog")) {
      stopVoiceRecognition();
      $("#voice-dialog").close();
    }
  });
  $("#voice-dialog").addEventListener("cancel", stopVoiceRecognition);
  $("#entry-dialog").addEventListener("click", (event) => {
    if (event.target === $("#entry-dialog")) $("#entry-dialog").close();
  });
  $("#card-dialog").addEventListener("click", (event) => {
    if (event.target === $("#card-dialog")) $("#card-dialog").close();
  });
  $(".notice-dismiss").addEventListener("click", () => $(".notice").remove());
  updateNotificationControls();
  initializeCloud();
}

document.addEventListener("DOMContentLoaded", initialize);
