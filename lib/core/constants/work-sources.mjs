// @ts-check


/**
 * @file The Symphony §11.4 work-source category vocabulary.
 * @version 0.12.0
 *
 * @description
 * The one owner of the eight strings a `WorkSourceError.category` may use.
 * `WorkSourceCategory` derives from this tuple, so a category is added here and
 * nowhere else; the scheduler branches only on success/failure, so the value is
 * diagnostic and for host telemetry.
 */

/**
 * The Symphony §11.4 categories, in their canonical order.
 */
export const WORK_SOURCE_CATEGORIES = Object.freeze(/** @type {const} */ ([
    'unsupported_tracker_kind',
    'invalid_tracker_config',
    'missing_tracker_secret',
    'tracker_request',
    'tracker_status',
    'tracker_response',
    'tracker_pagination',
    'tracker_rate_limited'
]));
