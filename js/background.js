// Manifest V3 background service worker.

const ports = new Set();

let ticketRefreshInProgress = false;

function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function sendToPorts(name, message) {
    for (const port of ports) {
        if (name && port.name !== name) {
            continue;
        }
        try {
            port.postMessage(message);
        } catch {
            // Ignore broken ports
        }
    }
}

const settings = {
    zendeskDomain: '',
    viewID: null,
    userID: null,
    viewFilterIds: [],
    notifyViewIds: [],
    pollInterval: 5,

    async load() {
        const loaded = await storageGet(null);
        this.zendeskDomain = loaded.zendeskDomain || '';
        this.viewID = loaded.viewID || null;
        this.userID = loaded.userID || null;
        this.viewFilterIds = Array.isArray(loaded.viewFilterIds) ? loaded.viewFilterIds : [];
        if (Array.isArray(loaded.notifyViewIds)) {
            this.notifyViewIds = loaded.notifyViewIds;
        } else if (loaded.notifyViewID) {
            this.notifyViewIds = [loaded.notifyViewID];
        } else {
            this.notifyViewIds = [];
        }
        this.pollInterval = loaded.pollInterval || 5;
    },

    async save() {
        await storageSet({
            zendeskDomain: this.zendeskDomain,
            viewID: this.viewID,
            userID: this.userID,
            viewFilterIds: this.viewFilterIds,
            notifyViewIds: this.notifyViewIds,
            pollInterval: this.pollInterval,
        });
        update_alarm();
    },
};

const model = {
    tickets: {},
    users: {},
    starred: [],
    currentlyMakingRequest: false,
    numRequestsTotal: 0,
    numRequestsDone: 0,
    errorState: false,
    lastUpdated: null,

    async load() {
        const loaded = await storageGet(null);
        this.starred = loaded.starred || [];
    },

    async save() {
        await storageSet({
            starred: this.starred,
        });
    },

    toggle_star(ticketIdStr) {
        const ticketId = Number.parseInt(ticketIdStr, 10);
        const index = this.starred.indexOf(ticketId);
        if (index === -1) {
            this.starred.push(ticketId);
        } else {
            this.starred.splice(index, 1);
        }
    },
};

let initialized = false;
async function ensureInitialized() {
    if (initialized) {
        return;
    }
    initialized = true;
    await settings.load();
    await model.load();
    update_time();
    update_alarm();
}

function snapshotState() {
    return {
        settings: {
            zendeskDomain: settings.zendeskDomain,
            viewID: settings.viewID,
            userID: settings.userID,
            viewFilterIds: settings.viewFilterIds,
            notifyViewIds: settings.notifyViewIds,
            pollInterval: settings.pollInterval,
        },
        model: {
            tickets: model.tickets,
            users: model.users,
            starred: model.starred,
            currentlyMakingRequest: model.currentlyMakingRequest,
            numRequestsTotal: model.numRequestsTotal,
            numRequestsDone: model.numRequestsDone,
            errorState: model.errorState,
            lastUpdated: model.lastUpdated,
        },
    };
}

function error_message(status) {
    const possibleErrors = {
        0: 'Request Unsent',
        400: 'Bad Request',
        401: 'Not Authorized. Please log in to Zendesk',
        403: 'Forbidden',
        404: 'Not Found. Check your Domain and View ID',
        500: 'Internal Server Error',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
    };

    if (Object.prototype.hasOwnProperty.call(possibleErrors, status)) {
        return `${status}: ${possibleErrors[status]}`;
    }
    return String(status);
}

function update_time() {
    model.lastUpdated = new Date();
}

function send_progress_to_popup(progress_value) {
    const minProgressValue = 5;

    let value = progress_value;
    if (typeof value !== 'number') {
        if (model.numRequestsTotal > 1) {
            const calculation = (model.numRequestsDone / model.numRequestsTotal) * 100;
            value = calculation > minProgressValue ? calculation : minProgressValue;
        } else if (model.numRequestsTotal === 1) {
            value = minProgressValue;
        } else {
            value = 0;
        }
    }

    sendToPorts('popup', { type: 'progress', value });
}

function progress_increment() {
    model.numRequestsDone += 1;
    if (model.numRequestsTotal > 0 && (model.numRequestsDone / model.numRequestsTotal) * 100 < 100) {
        send_progress_to_popup();
    }
}

function progress_all_done() {
    send_progress_to_popup(100);
    model.numRequestsTotal = 0;
    model.numRequestsDone = 0;
}

function tell_popup_loading() {
    sendToPorts('popup', { type: 'loading' });
}

function refresh_popup() {
    sendToPorts('popup', { type: 'refresh' });
}

function send_popup_failure(error) {
    model.currentlyMakingRequest = false;
    sendToPorts('popup', { type: 'error', error });
}

async function fetchJSON(url, options) {
    const trackProgress = !!(options && options.trackProgress);

    if (trackProgress) {
        model.numRequestsTotal += 1;
        send_progress_to_popup();
    }

    let response;
    try {
        response = await fetch(url, {
            credentials: 'include',
            headers: {
                Accept: 'application/json',
            },
        });
    } catch {
        throw { status: 0 };
    }

    if (!response.ok) {
        throw { status: response.status };
    }

    const json = await response.json();
    if (trackProgress) {
        progress_increment();
    }
    return json;
}

function get_current_user(domainOverride) {
    const domain = domainOverride || settings.zendeskDomain;
    const url = `https://${domain}.zendesk.com/api/v2/users/me.json`;
    return fetchJSON(url, { trackProgress: false });
}

function get_current_user_views(domainOverride) {
    const domain = domainOverride || settings.zendeskDomain;
    const url = `https://${domain}.zendesk.com/api/v2/views.json`;
    return fetchJSON(url, { trackProgress: false });
}

function get_tickets() {
    const url = `https://${settings.zendeskDomain}.zendesk.com/api/v2/views/${settings.viewID}/tickets.json`;
    return fetchJSON(url, { trackProgress: true });
}

function get_ticket_audits(ticketId) {
    const url = `https://${settings.zendeskDomain}.zendesk.com/api/v2/tickets/${ticketId}/audits.json`;
    return fetchJSON(url, { trackProgress: true });
}

function get_ticket_audits_page(ticketId, page) {
    const url = `https://${settings.zendeskDomain}.zendesk.com/api/v2/tickets/${ticketId}/audits.json?page=${page}`;
    return fetchJSON(url, { trackProgress: true });
}

async function get_all_ticket_audits(ticketId) {
    const first = await get_ticket_audits(ticketId);
    const theseAudits = first.audits || [];
    const numAudits = first.count || 0;
    const totalPages = Math.floor((numAudits - 1) / 100) + 1 || 1;

    const allAudits = [];
    allAudits.push(...theseAudits);

    if (totalPages === 1) {
        return allAudits;
    }

    const pagePromises = [];
    for (let page = 2; page <= totalPages; page++) {
        pagePromises.push(get_ticket_audits_page(ticketId, page));
    }
    const pageResponses = await Promise.all(pagePromises);
    for (const resp of pageResponses) {
        allAudits.push(...(resp.audits || []));
    }
    return allAudits;
}

function get_user_details(userId) {
    const url = `https://${settings.zendeskDomain}.zendesk.com/api/v2/users/${userId}.json`;
    return fetchJSON(url, { trackProgress: true });
}

function load_tickets_into_model(ticketsData) {
    // populates model.ticket as {ticket ID: ticket object}

    model.tickets = {};
    for (var i = 0; i < ticketsData.length; i++) {
        model.tickets[ticketsData[i].id] = ticketsData[i];
    }
}

function filter_events_for_comment(event) {
    return event.type === 'Comment';
}

function filter_events_for_public_comment_by_me(event) {
    return event.type === 'Comment' &&
        event.public === true &&
        event.author_id === settings.userID;
}

function generic_search_in_audits_with_filter(audits, filter) {
    var lastComment = null;

    for (var j = audits.length - 1; j >= 0 && lastComment === null; j--) {
        var createdDateTime = audits[j].created_at;
        var events = audits[j].events;

        // filter this audit's events for all comments
        var eventsFilteredAll = events.filter(filter);
        lastComment = eventsFilteredAll[0] || null;

        if (lastComment) {
            lastComment.created_at = createdDateTime;
        }
    }
    return lastComment;
}

function get_last_comment_from_audits(audits) {
    return generic_search_in_audits_with_filter(
        audits, filter_events_for_comment);
}

function get_last_comment_by_me_from_audits(audits) {
    return generic_search_in_audits_with_filter(
        audits, filter_events_for_public_comment_by_me);
}

function set_ticket_last_comments_from_audits(auditResponsesArray) {
    for (var i = 0; i < auditResponsesArray.length; i++) {
        var audits = auditResponsesArray[i];
        var ticketId = audits[0].ticket_id;

        console.log('Analyzing audits for ticket ID ' + ticketId +
            ', with a total of ' + audits.length + ' audits');
        model.tickets[ticketId]._lastComment =
            get_last_comment_from_audits(audits);
        model.tickets[ticketId]._lastPublicUpdateByMe =
            get_last_comment_by_me_from_audits(audits);
    }
}

function process_user_details(requesterArguments) {
    model.users = {};

    for (i = 0; i < requesterArguments.length; i++) {
        var user = requesterArguments[i][0].user;
        model.users[user.id] = user;
    }
}

async function get_tickets_and_details() {
    // get all tickets in view
    // get each ticket's audit history
    // get latest comment event in audit history and latest public comment by me
    // write data to model.tickets


    if (!preflight_check()) {
        return;
    }

    model.currentlyMakingRequest = true;
    model.errorState = false;
    ticketRefreshInProgress = true;

    tell_popup_loading();

    try {
        const data = await get_tickets();
        load_tickets_into_model(data.tickets);

        if ((data.tickets || []).length === 0) {
            update_tickets_with_details();
            return;
        }

        const auditRequests = [];
        const requesterIdRequests = [];

        for (let i = 0; i < data.tickets.length; i++) {
            const ticketId = data.tickets[i].id;
            const requesterId = data.tickets[i].requester_id;
            auditRequests.push(get_all_ticket_audits(ticketId));
            requesterIdRequests.push(get_user_details(requesterId));
        }

        const [requesterResponses, auditResponses] = await Promise.all([
            Promise.all(requesterIdRequests),
            Promise.all(auditRequests),
        ]);

        set_ticket_last_comments_from_audits(auditResponses);
        process_user_details(requesterResponses.map((r) => [r]));
        update_tickets_with_details();
    } catch (e) {
        model.currentlyMakingRequest = false;
        model.errorState = true;
        progress_all_done();
        send_popup_failure(error_message(e && e.status ? e.status : 0));
    } finally {
        ticketRefreshInProgress = false;
    }
}

function preflight_check() {
    if (!settings.zendeskDomain) {
        send_popup_failure('No domain specified');
        model.errorState = true;
        return false;
    } else if (!settings.userID) {
        send_popup_failure('No user ID specified');
        model.errorState = true;
        return false;
    } else if (!settings.viewID) {
        send_popup_failure('No view ID specified');
        model.errorState = true;
        return false;
    } else if (model.currentlyMakingRequest) {
        return false;
    }
    return true;
}

function update_tickets_with_details() {
    model.currentlyMakingRequest = false;
    model.errorState = false;
    update_time();
    refresh_popup();
    progress_all_done();
}

function tabsQuery(queryInfo) {
    return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function tabsUpdate(tabId, updateProperties) {
    return new Promise((resolve) => chrome.tabs.update(tabId, updateProperties, resolve));
}

function windowsUpdate(windowId, updateInfo) {
    return new Promise((resolve) => chrome.windows.update(windowId, updateInfo, resolve));
}

function tabsCreate(createProperties) {
    return new Promise((resolve) => chrome.tabs.create(createProperties, resolve));
}

function scriptingExecuteScript(details) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(details, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }
            resolve(result);
        });
    });
}

async function launch_zd_link(objectID, isView) {
    const property = isView ? 'show_filter' : 'ticket.index';
    const typeUrl = isView ? 'filters/' : 'tickets/';

    const tabQuery = {
        url: `*://${settings.zendeskDomain}.zendesk.com/agent/*`,
    };

    const tabs = await tabsQuery(tabQuery);
    const ZDtab = tabs[0];

    if (ZDtab && typeof ZDtab.id === 'number') {
        await scriptingExecuteScript({
            target: { tabId: ZDtab.id },
            world: 'MAIN',
            func: (prop, id) => {
                try {
                    // eslint-disable-next-line no-undef
                    Zendesk.router.transitionTo(prop, id);
                } catch {
                    // Fallback: inject a script tag
                    try {
                        const code = `Zendesk.router.transitionTo(${JSON.stringify(prop)}, ${JSON.stringify(id)});`;
                        const script = document.createElement('script');
                        script.textContent = code;
                        (document.head || document.documentElement).appendChild(script);
                        script.remove();
                    } catch {
                        // Ignore
                    }
                }
            },
            args: [property, objectID],
        });

        await tabsUpdate(ZDtab.id, { active: true });
        if (typeof ZDtab.windowId === 'number') {
            await windowsUpdate(ZDtab.windowId, { focused: true });
        }
        return;
    }

    const newURL = `https://${settings.zendeskDomain}.zendesk.com/agent/${typeUrl}${objectID}`;
    await tabsCreate({ url: newURL });
}

async function update_alarm() {
    await chrome.alarms.clear('pollTickets');
    const notifyIds = (settings.notifyViewIds || []).filter((v) => Number.isFinite(v));
    if (notifyIds.length > 0 && settings.pollInterval > 0) {
        chrome.alarms.create('pollTickets', {
            periodInMinutes: settings.pollInterval,
        });
    }
}

let lastNotifiedViewId = null;

async function check_notification_queue() {
    const notifyIds = (settings.notifyViewIds || [])
        .map((v) => Number.parseInt(v, 10))
        .filter((v) => Number.isFinite(v));

    if (!notifyIds.length || !settings.zendeskDomain) {
        return;
    }

    try {
        const stored = await storageGet(['notifySeen']);
        const seenMap = stored.notifySeen && typeof stored.notifySeen === 'object' ? stored.notifySeen : {};

        for (const viewId of notifyIds.slice(0, 3)) {
            const url = `https://${settings.zendeskDomain}.zendesk.com/api/v2/views/${viewId}/tickets.json`;
            const data = await fetchJSON(url, { trackProgress: false });
            const tickets = data.tickets || [];
            const currentIds = tickets.map((t) => t.id);

            if (!Array.isArray(seenMap[viewId])) {
                seenMap[viewId] = currentIds;
                continue;
            }

            const newTickets = tickets.filter((t) => !seenMap[viewId].includes(t.id));
            if (newTickets.length > 0) {
                const ticketWord = newTickets.length === 1 ? 'ticket' : 'tickets';
                const firstTicket = newTickets[0] || {};
                const submitterId = firstTicket.submitter_id || firstTicket.requester_id;
                let submitterName = 'Unknown';
                if (submitterId) {
                    try {
                        const userResp = await fetchJSON(
                            `https://${settings.zendeskDomain}.zendesk.com/api/v2/users/${submitterId}.json`,
                            { trackProgress: false },
                        );
                        submitterName = (userResp && userResp.user && userResp.user.name) ? userResp.user.name : submitterName;
                    } catch {
                        // ignore
                    }
                }

                const rawDescription = String(firstTicket.description || firstTicket.subject || '').replace(/\s+/g, ' ').trim();
                const description = rawDescription.length > 120 ? `${rawDescription.slice(0, 117)}...` : rawDescription;
                chrome.notifications.create(`notify_${Date.now()}`, {
                    type: 'basic',
                    iconUrl: chrome.runtime.getURL('icon/icon-128.png'),
                    title: `${newTickets.length} new ${ticketWord} in monitored view`,
                    message: `Submitter: ${submitterName}`,
                    contextMessage: description,
                });
                lastNotifiedViewId = viewId;
            }

            seenMap[viewId] = currentIds;
        }

        await storageSet({ notifySeen: seenMap });
    } catch (e) {
        console.error('Error polling monitored view', e);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'pollTickets') {
        check_notification_queue();
    }
});

chrome.notifications.onClicked.addListener(() => {
    if (lastNotifiedViewId) {
        launch_zd_link(lastNotifiedViewId, true);
    }
});

chrome.runtime.onInstalled.addListener(() => {
    // Best-effort init
    ensureInitialized();
});

chrome.runtime.onStartup.addListener(() => {
    ensureInitialized();
});

chrome.runtime.onConnect.addListener((port) => {
    ports.add(port);
    port.onDisconnect.addListener(() => {
        ports.delete(port);
        model.save();
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        await ensureInitialized();

        switch (message && message.type) {
            case 'getState': {
                sendResponse({ ok: true, data: snapshotState() });
                return;
            }
            case 'getSettings': {
                sendResponse({ ok: true, data: { settings: snapshotState().settings } });
                return;
            }
            case 'setSettings': {
                const next = message.settings || {};
                settings.zendeskDomain = next.zendeskDomain || '';
                settings.viewID = Number.parseInt(next.viewID, 10) || null;
                settings.userID = Number.parseInt(next.userID, 10) || null;
                if (Array.isArray(next.notifyViewIds)) {
                    settings.notifyViewIds = next.notifyViewIds
                        .map((v) => Number.parseInt(v, 10))
                        .filter((v) => Number.isFinite(v));
                } else if (next.notifyViewID) {
                    settings.notifyViewIds = [Number.parseInt(next.notifyViewID, 10) || null]
                        .filter((v) => Number.isFinite(v));
                } else {
                    settings.notifyViewIds = [];
                }
                settings.pollInterval = Number.parseInt(next.pollInterval, 10) || 5;
                if (Array.isArray(next.viewFilterIds)) {
                    settings.viewFilterIds = next.viewFilterIds
                        .map((v) => Number.parseInt(v, 10))
                        .filter((v) => Number.isFinite(v));
                }
                await settings.save();
                sendResponse({ ok: true });
                return;
            }
            case 'detectUserId': {
                const domain = message.zendeskDomain || settings.zendeskDomain;
                const resp = await get_current_user(domain);
                sendResponse({ ok: true, data: { user: resp.user } });
                return;
            }
            case 'listViews': {
                const domain = message.zendeskDomain || settings.zendeskDomain;
                const resp = await get_current_user_views(domain);
                sendResponse({ ok: true, data: { views: resp.views || [] } });
                return;
            }
            case 'refreshTickets': {
                await get_tickets_and_details();
                sendResponse({ ok: true, data: snapshotState() });
                return;
            }
            case 'toggleStar': {
                model.toggle_star(message.ticketId);
                await model.save();
                refresh_popup();
                sendResponse({ ok: true });
                return;
            }
            case 'launchLink': {
                await launch_zd_link(message.objectID, message.isView);
                sendResponse({ ok: true });
                return;
            }
            case 'testNotification': {
                chrome.notifications.create(`test_${Date.now()}`, {
                    type: 'basic',
                    iconUrl: chrome.runtime.getURL('icon/icon-128.png'),
                    title: 'Test Notification',
                    message: 'Submitter: Test User',
                    contextMessage: 'This is a test notification from Zendesk Prioritizer.',
                });
                sendResponse({ ok: true });
                return;
            }
            case 'forcePollCheck': {
                await check_notification_queue();
                sendResponse({ ok: true });
                return;
            }
            default: {
                sendResponse({ ok: false, error: 'Unknown message type' });
            }
        }
    })().catch((e) => {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
    });

    return true;
});
