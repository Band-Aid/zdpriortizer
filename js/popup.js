(function($) {

    function sendMessage(message) {
        return new Promise(function(resolve, reject) {
            chrome.runtime.sendMessage(message, function(response) {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }
                resolve(response);
            });
        });
    }

    var port = chrome.runtime.connect({ name: 'popup' });

    var uiReady = false;
    var pendingPortMessages = [];

    function handlePortMessage(msg) {
        if (!msg || !msg.type) {
            return;
        }
        if (!uiReady) {
            pendingPortMessages.push(msg);
            return;
        }

        if (msg.type === 'progress') {
            if (typeof window.setProgress === 'function') {
                window.setProgress(msg.value);
            }
        } else if (msg.type === 'loading') {
            if (typeof window.loading === 'function') {
                window.loading();
            }
        } else if (msg.type === 'error') {
            if (typeof window.failed === 'function') {
                window.failed(msg.error);
            }
        } else if (msg.type === 'refresh') {
            // Background says new data is ready
            refreshState().then(function() {
                if (typeof window.refreshTickets === 'function') {
                    window.refreshTickets();
                }
            });
        }
    }

    port.onMessage.addListener(handlePortMessage);

    var state = {
        settings: { zendeskDomain: '', viewID: null, userID: null },
        model: {
            tickets: {},
            users: {},
            starred: [],
            currentlyMakingRequest: false,
            errorState: false,
        },
    };

    var viewsCache = [];

    async function refreshState() {
        var resp = await sendMessage({ type: 'getState' });
        if (resp && resp.ok) {
            state = resp.data;
        }
        return state;
    }

    function renderViewSelect() {
        var select = $('#view-select');
        if (!select.length) {
            return;
        }

        var current = state.settings.viewID;
        var allowed = Array.isArray(state.settings.viewFilterIds) ? state.settings.viewFilterIds : [];
        var allowedSet = {};
        for (var k = 0; k < allowed.length; k++) {
            allowedSet[String(allowed[k])] = true;
        }

        select.empty();
        select.append('<option value="">Select…</option>');

        var currentWasAdded = false;

        for (var i = 0; i < viewsCache.length; i++) {
            var v = viewsCache[i];
            if (!v || v.active === false) {
                continue;
            }

            var isAllowed = (allowed.length === 0) || !!allowedSet[String(v.id)];
            if (!isAllowed && current && String(v.id) !== String(current)) {
                continue;
            }
            var selected = (current && String(v.id) === String(current)) ? ' selected' : '';
            if (selected) {
                currentWasAdded = true;
            }
            var $option = $('<option>')
                .val(v.id)
                .prop('selected', !!selected)
                .text(String(v.title || v.id));
            select.append($option);
        }

        // If current view isn't in the views list (or filtered out), keep it visible.
        if (current && !currentWasAdded) {
            var $option = $('<option>')
                .val(current)
                .prop('selected', true)
                .text(String(current));
            select.append($option);
        }

        if (!state.settings.zendeskDomain) {
            select.prop('disabled', true);
        } else {
            select.prop('disabled', false);
        }
    }

    async function loadViews() {
        if (!state.settings.zendeskDomain) {
            viewsCache = [];
            renderViewSelect();
            return;
        }

        var resp = await sendMessage({
            type: 'listViews',
            zendeskDomain: state.settings.zendeskDomain,
        });

        if (resp && resp.ok && resp.data && Array.isArray(resp.data.views)) {
            viewsCache = resp.data.views;
        } else {
            viewsCache = [];
        }
        renderViewSelect();
    }

    $(function() {

        var isChangingView = false;

        $('#view-select').on('change', function() {
            if (isChangingView) {
                return;
            }
            var nextViewId = $(this).val();
            if (!nextViewId) {
                return;
            }

            isChangingView = true;
            window.loading();

            state.settings.viewID = parseInt(nextViewId, 10) || null;
            sendMessage({ type: 'setSettings', settings: state.settings })
                .then(function() {
                    return sendMessage({ type: 'refreshTickets' });
                })
                .then(function(resp) {
                    if (resp && resp.ok) {
                        state = resp.data;
                    }
                    renderViewSelect();
                    window.refreshTickets();
                })
                .catch(function(err) {
                    window.failed(err && err.message ? err.message : String(err));
                })
                .finally(function() {
                    isChangingView = false;
                });
        });

        window.loading = function() {
            $('#loading').html('Loading...');
        };

        window.setProgress = function(progress_value) {
            var progressbarElement = $("#progressbar");

            progressbarElement.css('opacity', '1');
            progressbarElement.progressbar({
                value: progress_value
            });

            if (progress_value >= 100) {
                progressbarElement.css('opacity', '0');
            }
        };

        window.refreshTickets = function() {
            console.log('Background told me to refresh');
            show_tickets();
            add_ticket_click_handlers();
            $('#loading').html('');
        };

        window.failed = function(error) {
            console.log('Background experienced error');
            $('#error').html('Error - ' + error);
            $('#error').css('display', 'block');
            $('#loading').html('');
            $('ul').empty();
        };

        var today = {
            now: null,
            startTime: null,
            endTime: null
        };

        function update_start_and_end_time() {

            today.now = new Date();

            var d1 = new Date(),
                d2 = new Date();

            d1.setHours(0, 0, 0, 0);
            d2.setHours(23, 59, 0, 0);
            today.startTime = d1;
            today.endTime = d2;
        }

        function answered_by_me_today(date) {

            var answeredDate = new Date(date);

            if (today.startTime < answeredDate && answeredDate < today.endTime) {

                return true;
            } else {
                return false;
            }
        }

        function object_to_array(object) {

            var array = [];
            for (var key in object) {
                array.push(object[key]);
            }
            return array;
        }

        function get_property(object, key) {

            return key.split('.').reduce(function(obj, param) {
                return (typeof obj === 'undefined' || obj === null) ? null : obj[param];
            }, object);
        }

        function sort_waitTime(a, b) {
            // sort by descending wait time (longest wait time at top)

            var timeA = new Date(get_property(a, '_lastPublicUpdateByMe.created_at'));
            var timeB = new Date(get_property(b, '_lastPublicUpdateByMe.created_at'));
            return timeA - timeB;
        }

        function sort_responded(a, b) {
          /** sort by asending order of responded state (unresponded at top)
           *   / original /
            //var timeA = new Date(get_property(a, '_lastPublicUpdateByMe.created_at'));
            //var timeB = new Date(get_property(b, '_lastPublicUpdateByMe.created_at'));
           
          
       
            
           /Sory by ticket created date/
           var timeA = new Date(get_property(a, 'ThisTicket.created_at'));
            var timeB = new Date(get_property(b, 'ThisTicket.created_at'));
          **/
          
            var timeA = new Date(get_property(a, '_lastComment.created_at'));
            var timeB = new Date(get_property(b, '_lastComment.created_at'));
            var respondedA = (today.startTime < timeA && timeA < today.endTime) ? 1 : 0;
            var respondedB = (today.startTime < timeB && timeB < today.endTime) ? 1 : 0;
            return respondedA - respondedB;
        }

        function sort_priority(a, b) {
            // sort by descending priority (high priority on top)

            var priorityA = convert_priority_to_int(a.priority);
            var priorityB = convert_priority_to_int(b.priority);

            function convert_priority_to_int(priority) {
                switch (priority) {
                    case 'low':
                        return 1;
                    case null:
                        return 2;
                    case 'normal':
                        return 2;
                    case 'high':
                        return 3;
                    case 'urgent':
                        return 4;
                    default:
                        console.log('Could not match priority string: ' + priority);
                }
            }
            return priorityB - priorityA;
        }

        function sort_starred(a, b) {

            var starred = state.model.starred;

            var starredA = (starred.indexOf(a.id) > -1) ? 1 : 0;
            var starredB = (starred.indexOf(b.id) > -1) ? 1 : 0;

            return starredB - starredA;
        }

        // sourced from https://github.com/Teun/thenBy.js
        var firstBy = (function() { // this function takes no arguments and returns another function
            function extend(func) {
                func.thenBy = tb;
                return func; // returns a function that has a `.thenBy` function parameter
            }

            function tb(y) {
                var x = this; // `this` refers to the function that called `.thenBy`
                return extend(function(a, b) { // returns a function that has another `.thenBy` function parameter
                    return x(a, b) || y(a, b); // if x(a,b) === 0, return y(a,b) (if this function deems items equal, go to next function)
                });
            }
            return extend; // this is then assigned to `firstBy`
        })();
        
        function show_tickets() {

            // don't try to populate tickets unless bg has valid data
            if (state.model.currentlyMakingRequest || state.model.errorState) {
                return;
            }

            // clean up
            $('#error').css('display', 'none');
            $('ul').empty();

            var ticketsArray = object_to_array(state.model.tickets);

            if (ticketsArray.length === 0) {
                $('ul').append('<div class="notification-li">No tickets in view</div>');
                return;
            }

            // Multi-attribute sorting
            //.thenBy(sort_priority)
            ticketsArray.sort(firstBy(sort_responded).thenBy(sort_starred).thenBy(sort_waitTime));

            var tickets = '';
            var starred = state.model.starred;

            for (var index in ticketsArray) {

                var thisTicket = ticketsArray[index];
                
                var lastComment = thisTicket._lastComment || { body: '', created_at: null };
                var latestCommentBody = lastComment.body || '';
                var latestCommentDate = lastComment.created_at ? new Date(lastComment.created_at) : null;
                var latestCommentTimeStr = latestCommentDate ? moment(latestCommentDate).fromNow() : '';
                var description = '';
                if (latestCommentBody.length > 152) {
                    description = latestCommentBody.substring(0, 151) + '... [' + latestCommentTimeStr + ']';
                } else {
                    description = latestCommentBody + ' [' + latestCommentTimeStr + ']';
                }
                var subject = thisTicket.subject;
                if (subject.length > 100) {
                    subject = subject.substring(0, 99) + '...';
                }
                var priority = thisTicket.priority || '';
                var answeredToday;
                if (thisTicket._lastPublicUpdateByMe) {
                    answeredToday = answered_by_me_today(
                        thisTicket._lastPublicUpdateByMe.created_at);
                } else {
                    answeredToday = false;
                }

                var isStarred = (starred.indexOf(thisTicket.id) > -1) ? true : false;
                var requesterName = (state.model.users[thisTicket.requester_id] || {}).name || '';

                // var requester = bg.model.users[];

                tickets += 
                    '<li data-ticketid="' + thisTicket.id + '" class="tickets-li">' + " " + thisTicket.id + subject +
                    '<div class="responded ' + answeredToday + '"></div>' +
                    '<div class="priority ' + priority + '"></div>' +
                    '<div class="starred ' + isStarred + '"></div>' +
                    '<div class="description">' + description + '</div>' +
                    '<div class="requester">' + requesterName + '</div>' +
                    '</li>';
            }

            $('ul').append(tickets); // appending everything at once fixes the unwanted "grow" effect of appending one at a time
            add_ellipses();
        }

        function add_ticket_click_handlers() {

            // console.log('Adding click handlers');
            $('.tickets-li').click(handler_launch_ticket);
            $('.starred').click(handler_toggle_favorite);
        }

        function add_ellipses() {
            $('.requester').dotdotdot();
            // $('.description').dotdotdot({
            //     height:20
            // });
        }

        function handler_launch_ticket(e) {

            var ID = $(this).attr('data-ticketid');
            console.log('Opening ticket ' + ID);
            sendMessage({ type: 'launchLink', objectID: ID, isView: false });
        }

        function handler_launch_view(e) {

            var viewId = state.settings.viewID;
            if (viewId) {
                sendMessage({ type: 'launchLink', objectID: viewId, isView: true });
            } else {
                self.failed('No view ID specified');
            }
        }
        
        

        function handler_toggle_favorite(e) {

            e.stopPropagation(); // stop click event on div underneath from firing
            var ID = $(this).parent().attr('data-ticketid');
            console.log('toggling starred for ' + ID);
            sendMessage({ type: 'toggleStar', ticketId: ID }).then(function() {
                refreshState().then(function() {
                    window.refreshTickets();
                });
            });
        }

        update_start_and_end_time();
        $('#view-icon').click(handler_launch_view); // only needs to attach once

        uiReady = true;
        if (pendingPortMessages.length) {
            var queued = pendingPortMessages.slice(0);
            pendingPortMessages = [];
            queued.forEach(handlePortMessage);
        }

        window.loading();
        refreshState()
            .then(function() {
                return loadViews();
            })
            .then(function() {
                show_tickets();
                add_ticket_click_handlers();
            })
            .then(function() {
                return sendMessage({ type: 'refreshTickets' });
            })
            .then(function(resp) {
                if (resp && resp.ok) {
                    state = resp.data;
                }
                return loadViews();
            })
            .then(function() {
                window.refreshTickets();
            })
            .catch(function(err) {
                window.failed(err && err.message ? err.message : String(err));
            });
    });
    
})(jQuery);
