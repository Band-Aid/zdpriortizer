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
    };

    $(function() {

        function normalize_settings_from_inputs() {
            settings.zendeskDomain = inputDomain.val();
            settings.userID = parseInt(inputUserId.val(), 10) || null;
            settings.viewID = parseInt(inputViewId.val(), 10) || null;
        }

        var inputDomain = $('#input-domain');
        var inputUserId = $('#input-userid');
        var inputViewId = $('#input-viewid');
        var buttonDetectUserId = $('#button-detectuserid');
        var buttonListUserViews = $('#button-viewselect');
        var buttonLogIn = $('#button-login');

        function load() {
            inputDomain.val(settings.zendeskDomain);
            inputUserId.val(settings.userID);
            inputViewId.val(settings.viewID);
        }

        function save() {
            normalize_settings_from_inputs();
            clear_error_domain();
            sendMessage({ type: 'setSettings', settings: settings }).catch(function() {
                // ignore
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
            $('ul.dropdown-menu').empty();
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
                    add_views_from_response_to_dropdown({ views: response.data.views });
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

        function add_views_from_response_to_dropdown(response) {

            $('ul.dropdown-menu').empty();
            var viewsObject = response.views;
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

            $('ul.dropdown-menu').append(views);
            $('.view-item').click(handler_fill_viewid_input_with_selection);
        }

        function open_login_window() {

            if (settings.zendeskDomain) {
                url = 'https://' + settings.zendeskDomain + '.zendesk.com/agent';
                window.open(url);
            } else {
                show_error_domain();
            }
        }

        function handler_fill_viewid_input_with_selection() {

            var viewId = $(this).attr('data-viewid');
            inputViewId.val(viewId);
            buttonListUserViews.dropdown('hide');
            save();
        }

        sendMessage({ type: 'getSettings' })
            .then(function(resp) {
                if (resp && resp.ok && resp.data && resp.data.settings) {
                    settings = resp.data.settings;
                }
                load();
            })
            .catch(function() {
                load();
            });

        inputDomain.on('input', save);
        inputUserId.on('input', save);
        inputViewId.on('input', save);
        buttonDetectUserId.click(detect_user_id);
        buttonListUserViews.click(list_user_views);
        buttonLogIn.click(open_login_window);
    });

})(jQuery);
