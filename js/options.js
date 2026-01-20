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

    chrome.runtime.connect({ name: 'options' });

    var settings = {
        zendeskDomain: '',
        viewID: null,
        userID: null,
        viewFilterIds: [],
        notifyViewIds: [],
        pollInterval: 5,
    };

    $(function() {

        function normalize_settings_from_inputs() {
            settings.zendeskDomain = inputDomain.val();
            settings.userID = parseInt(inputUserId.val(), 10) || null;
            settings.viewID = parseInt(inputViewId.val(), 10) || null;
            settings.pollInterval = parseInt(inputPollInterval.val(), 10) || 5;
        }

        var inputDomain = $('#input-domain');
        var inputUserId = $('#input-userid');
        var inputViewId = $('#input-viewid');
        var inputPollInterval = $('#input-poll-interval');
        var buttonDetectUserId = $('#button-detectuserid');
        var buttonListUserViews = $('#button-viewselect');
        var buttonLogIn = $('#button-login');
        var buttonLoadViews = $('#button-loadviews');
        var buttonTestNotification = $('#button-test-notification');
        var viewFilterList = $('#view-filter-list');
        var notifyViewList = $('#notify-view-list');

        var viewsCache = [];

        function load() {
            inputDomain.val(settings.zendeskDomain);
            inputUserId.val(settings.userID);
            inputViewId.val(settings.viewID);
            if (!Array.isArray(settings.notifyViewIds)) {
                settings.notifyViewIds = settings.notifyViewID ? [settings.notifyViewID] : [];
            }
            inputPollInterval.val(settings.pollInterval);
        }

        function save() {
            normalize_settings_from_inputs();
            clear_error_domain();
            sendMessage({ type: 'setSettings', settings: settings }).catch(function() {
                // ignore
            });
        }

        function render_view_filter_list() {
            viewFilterList.empty();

            if (!settings.zendeskDomain) {
                viewFilterList.append('<div class="view-row"><div class="view-title">Set Domain first</div></div>');
                return;
            }

            if (!viewsCache.length) {
                viewFilterList.append('<div class="view-row"><div class="view-title">No views loaded</div></div>');
                return;
            }

            var selected = Array.isArray(settings.viewFilterIds) ? settings.viewFilterIds : [];
            var selectedSet = {};
            for (var i = 0; i < selected.length; i++) {
                selectedSet[String(selected[i])] = true;
            }

            for (var j = 0; j < viewsCache.length; j++) {
                var v = viewsCache[j];
                if (!v || v.active === false) {
                    continue;
                }

                var checked = selected.length === 0 ? '' : (selectedSet[String(v.id)] ? ' checked' : '');
                var row = '';
                row += '<label class="view-row">';
                row += '<input type="checkbox" class="view-filter-checkbox" data-viewid="' + v.id + '"' + checked + '>';
                row += '<div class="view-title">' + String(v.title || v.id) + '</div>';
                row += '<div class="view-meta">' + v.id + '</div>';
                row += '</label>';
                viewFilterList.append(row);
            }

            // When there are no saved selections, treat as "show all".
            // As soon as the user toggles any checkbox, we start storing an explicit allow-list.
            $('.view-filter-checkbox').on('change', function() {
                var checkedIds = [];
                $('.view-filter-checkbox:checked').each(function() {
                    checkedIds.push(parseInt($(this).attr('data-viewid'), 10));
                });
                settings.viewFilterIds = checkedIds;
                sendMessage({ type: 'setSettings', settings: settings }).catch(function() {
                    // ignore
                });
            });
        }

        function render_notify_view_list() {
            notifyViewList.empty();

            if (!settings.zendeskDomain) {
                notifyViewList.append('<div class="view-row"><div class="view-title">Set Domain first</div></div>');
                return;
            }

            if (!viewsCache.length) {
                notifyViewList.append('<div class="view-row"><div class="view-title">No views loaded</div></div>');
                return;
            }

            var selected = Array.isArray(settings.notifyViewIds) ? settings.notifyViewIds : [];
            var selectedSet = {};
            for (var i = 0; i < selected.length; i++) {
                selectedSet[String(selected[i])] = true;
            }

            for (var j = 0; j < viewsCache.length; j++) {
                var v = viewsCache[j];
                if (!v || v.active === false) {
                    continue;
                }

                var checked = selectedSet[String(v.id)] ? ' checked' : '';
                var row = '';
                row += '<label class="view-row">';
                row += '<input type="checkbox" class="notify-view-checkbox" data-viewid="' + v.id + '"' + checked + '>';
                row += '<div class="view-title">' + String(v.title || v.id) + '</div>';
                row += '<div class="view-meta">' + v.id + '</div>';
                row += '</label>';
                notifyViewList.append(row);
            }

            $('.notify-view-checkbox').on('change', function(e) {
                var checkedIds = [];
                $('.notify-view-checkbox:checked').each(function() {
                    checkedIds.push(parseInt($(this).attr('data-viewid'), 10));
                });

                if (checkedIds.length > 3) {
                    $(e.target).prop('checked', false);
                    return;
                }

                settings.notifyViewIds = checkedIds;
                sendMessage({ type: 'setSettings', settings: settings }).catch(function() {
                    // ignore
                });
            });
        }

        function load_views_for_filter() {
            if (!settings.zendeskDomain) {
                show_error_domain();
                render_view_filter_list();
                return;
            }

            buttonLoadViews.attr('disabled', true);
            render_view_filter_list();

            sendMessage({ type: 'listViews', zendeskDomain: settings.zendeskDomain })
                .then(function(response) {
                    buttonLoadViews.removeAttr('disabled');
                    if (!response || !response.ok) {
                        throw new Error((response && response.error) ? response.error : 'Unknown error');
                    }
                    viewsCache = response.data.views || [];
                    render_view_filter_list();
                    render_notify_view_list();
                })
                .catch(function() {
                    buttonLoadViews.removeAttr('disabled');
                    viewsCache = [];
                    render_view_filter_list();
                    render_notify_view_list();
                });
        }

        function detect_user_id() {

            if (!inputDomain.val()) {
                show_error_domain();
                return;
            }

            buttonDetectUserId.attr('disabled', true);
            load();  // load to clear error messages

            normalize_settings_from_inputs();

            sendMessage({ type: 'detectUserId', zendeskDomain: settings.zendeskDomain })
                .then(function(response) {
                    buttonDetectUserId.removeAttr('disabled');
                    if (!response || !response.ok) {
                        throw new Error((response && response.error) ? response.error : 'Unknown error');
                    }
                    var userId = response.data.user.id;
                    if (!userId) {
                        inputUserId.val('Unauthorized');
                        inputUserId.css('color', '#ec514e');
                    } else {
                        inputUserId.val(userId);
                        inputUserId.css('color', '#c6c8c8');
                        save();
                    }
                })
                .catch(function(err) {
                    buttonDetectUserId.removeAttr('disabled');
                    inputUserId.val(err && err.message ? err.message : String(err));
                    inputUserId.css('color', '#ec514e');
                });
        }

        function list_user_views() {

            // Clean up dropdown menu
            $('#dropdown-1 .dropdown-menu').empty();
            buttonListUserViews.dropdown('disable');

            if (!inputDomain.val()) {
                show_error_domain();
                return;
            }

            buttonListUserViews.attr('disabled', true);
            load();  // load to clear error messages

            normalize_settings_from_inputs();

            sendMessage({ type: 'listViews', zendeskDomain: settings.zendeskDomain })
                .then(function(response) {
                    buttonListUserViews.removeAttr('disabled');
                    if (!response || !response.ok) {
                        throw new Error((response && response.error) ? response.error : 'Unknown error');
                    }
                    inputViewId.css('color', '#c6c8c8');
                    add_views_from_response_to_dropdown($('#dropdown-1 .dropdown-menu'), response.data.views, function(viewId) {
                        inputViewId.val(viewId);
                        buttonListUserViews.dropdown('hide');
                        save();
                    });
                    buttonListUserViews.dropdown('enable');
                    buttonListUserViews.dropdown('show');
                })
                .catch(function(err) {
                    buttonListUserViews.removeAttr('disabled');
                    inputViewId.val(err && err.message ? err.message : String(err));
                    inputViewId.css('color', '#ec514e');
                });
        }


        function show_error_domain() {
            inputDomain.addClass('input-error');
        }

        function clear_error_domain() {
            inputDomain.removeClass('input-error');
        }

        function object_to_array(object) {

            var array = [];
            for (var key in object) {
                array.push(object[key]);
            }
            return array;
        }

        function add_views_from_response_to_dropdown(dropdownMenu, viewsObject, onSelect) {

            dropdownMenu.empty();
            var viewsArray = object_to_array(viewsObject);
            var views = '';

            for (var view in viewsArray) {
                var thisView = viewsArray[view];

                // Skip inactive views
                if (thisView.active === false) {
                    continue;
                }

                views += '<li data-viewid="' + thisView.id + '" class="view-item">' +
                    thisView.title + '</li>';
            }

            dropdownMenu.append(views);
            dropdownMenu.find('.view-item').click(function() {
                var viewId = $(this).attr('data-viewid');
                if (onSelect) {
                    onSelect(viewId);
                }
            });
        }

        function open_login_window() {

            if (settings.zendeskDomain) {
                url = 'https://' + settings.zendeskDomain + '.zendesk.com/agent';
                window.open(url);
            } else {
                show_error_domain();
            }
        }

        sendMessage({ type: 'getSettings' })
            .then(function(resp) {
                if (resp && resp.ok && resp.data && resp.data.settings) {
                    settings = resp.data.settings;
                }
                load();
                load_views_for_filter();
                render_notify_view_list();
            })
            .catch(function() {
                load();
                render_view_filter_list();
                render_notify_view_list();
            });

        inputDomain.on('input', save);
        inputUserId.on('input', save);
        inputViewId.on('input', save);
        inputPollInterval.on('input', save);
        buttonDetectUserId.click(detect_user_id);
        buttonListUserViews.click(list_user_views);
        buttonTestNotification.click(function() {
            sendMessage({ type: 'forcePollCheck' }).catch(function() {
                // ignore
            });
        });
        buttonLogIn.click(open_login_window);
        buttonLoadViews.click(load_views_for_filter);
    });

})(jQuery);
