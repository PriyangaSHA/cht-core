/**
 * @module rules-state-store
 * In-memory datastore containing 
 * 1. Details on the state of each contact's rules calculations
 * 2. Target emissions @see target-state
 */
const md5 = require('md5');

const targetState = require('./target-state');

const EXPIRE_CALCULATION_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
let state;
let currentUser;
let onStateChange;

const self = {
  /**
   * Initializes the rules-state-store from an existing state. If existing state is invalid, builds an empty state.
   *
   * @param {Object} existingState State object previously passed to the stateChangeCallback
   * @param {Object} settingsDoc Settings document
   * @param {Object} userDoc User's hydrated contact document
   * @param {Object} stateChangeCallback Callback which is invoked whenever the state changes. Receives the updated state as the only parameter.
   */
  load: (existingState, settingsDoc, userDoc, stateChangeCallback) => {
    if (state) {
      throw Error('Attempted to initialize the rules-state-store multiple times.');
    }

    const rulesConfigHash = hashRulesConfig(settingsDoc, userDoc);
    const useState = existingState && existingState.rulesConfigHash === rulesConfigHash;
    if (!useState) {
      return self.build(settingsDoc, userDoc, stateChangeCallback);
    }

    state = existingState;
    currentUser = userDoc;
    onStateChange = safeCallback(stateChangeCallback);
  },

  /**
   * Initializes an empty rules-state-store.
   *
   * @param {Object} settingsDoc Settings document
   * @param {Object} userDoc User's hydrated contact document
   * @param {Object} stateChangeCallback Callback which is invoked whenever the state changes. Receives the updated state as the only parameter.
   */
  build: (settingsDoc, userDoc, stateChangeCallback) => {
    if (state) {
      throw Error('Attempted to initialize the rules-state-store multiple times.');
    }

    state = {
      rulesConfigHash: hashRulesConfig(settingsDoc, userDoc),
      contactState: {},
      targetState: targetState.createEmptyState(settingsDoc),
    };
    currentUser = userDoc;

    onStateChange = safeCallback(stateChangeCallback);
    return onStateChange(state);
  },

  /**
   * "Dirty" indicates that the contact's task documents are not up to date. They should be refreshed before being used.
   *
   * The dirty state can be due to:
   * 1. The time of a contact's most recent task calculation is unknown
   * 2. The contact's most recent task calculation expires
   * 3. The contact is explicitly marked as dirty
   * 4. Configurations impacting rules calculations have changed
   *
   * @param {string} contactId The id of the contact to test for dirtiness
   * @returns {Boolean} True if dirty
   */
  isDirty: contactId => {
    if (!state.contactState[contactId]) {
      return true;
    }

    const { calculatedAt, isDirty } = state.contactState[contactId];
    return !calculatedAt ||
      isDirty ||
      /* isExpired */ calculatedAt < Date.now() - EXPIRE_CALCULATION_AFTER_MS;
  },

  /**
   * Determines if either the settings document or user's hydrated contact document have changed in a way which will impact the result of rules calculations.
   * If they have changed in a meaningful way, the calculation state of all contacts is reset
   *
   * @param {Object} settingsDoc Settings document
   * @param {Object} userDoc User's hydrated contact document
   * @returns {Boolean} True if the state of all contacts has been reset
   */
  rulesConfigChange: (settingsDoc, userDoc) => {
    const rulesConfigHash = hashRulesConfig(settingsDoc, userDoc);
    if (state.rulesConfigHash !== rulesConfigHash) {
      state = {
        rulesConfigHash,
        contactState: {},
        targetState: targetState.createEmptyState(settingsDoc),
      };
      currentUser = userDoc;

      onStateChange(state);
      return true;
    }

    return false;
  },

  /**
   * @param {int} calculatedAt Timestamp of the calculation
   * @param {string[]} contactIds Array of contact ids to be marked as freshly calculated
   */
  markFresh: (calculatedAt, contactIds) => {
    if (!Array.isArray(contactIds)) {
      contactIds = [contactIds];
    }
    contactIds = contactIds.filter(id => id);

    if (contactIds.length === 0) {
      return;
    }

    for (let contactId of contactIds) {
      state.contactState[contactId] = { calculatedAt };
    }

    return onStateChange(state);
  },

  /**
   * @param {string[]} contactIds Array of contact ids to be marked as dirty
   */
  markDirty: contactIds => {
    if (!Array.isArray(contactIds)) {
      contactIds = [contactIds];
    }
    contactIds = contactIds.filter(id => id);

    if (contactIds.length === 0) {
      return;
    }

    for (let contactId of contactIds) {
      if (!state.contactState[contactId]) {
        state.contactState[contactId] = {};
      }

      state.contactState[contactId].isDirty = true;
    }

    return onStateChange(state);
  },

  /**
   * @returns {string[]} The id of all contacts tracked by the store
   */
  getContactIds: () => Object.keys(state.contactState),

  /**
   * The rules system supports the concept of "headless" reports and "headless" task documents. In these scenarios, a report exists on a user's device while the associated
   * contact document of that report is not on the device. A common scenario associated with this case is during supervisor workflows where supervisors sync reports with the
   * needs_signoff attribute but not the associated patient.
   *
   * In these cases, getting a list of "all the contacts with rules" requires us to look not just through contact docs, but also through reports. To avoid this costly operation,
   * the rules-state-store maintains a flag which indicates if the contact ids in the store can serve as a trustworthy authority.
   *
   * markAllFresh should be called when the list of contact ids within the store is the complete set of contacts with rules
   */
  markAllFresh: (calculatedAt, contactIds) => {
    state.allContactIds = true;
    return self.markFresh(calculatedAt, contactIds);
  },

  /**
   * @returns True if markAllFresh has been called on the current store state.
   */
  hasAllContacts: () => !!state.allContactIds,

  /**
   * @returns {string} User contact document
   */
  currentUser: () => currentUser,

  /**
   * Store a set of target emissions which were emitted by refreshing a set of contacts
   *
   * @param {string[]} contactIds An array of contact ids which produced these targetEmissions by being refreshed. If undefined, all contacts are updated.
   * @param {Object[]} targetEmissions An array of target emissions (the result of the rules-emitter).
   */
  storeTargetEmissions: (contactIds, targetEmissions) => {
    const isUpdated = targetState.storeTargetEmissions(state.targetState, contactIds, targetEmissions);
    if (isUpdated) {
      return onStateChange(state);
    }
  },

  /**
   * Aggregates the stored target emissions into target models
   *
   * @param {Function(emission)=} targetEmissionFilter Filter function to filter which target emissions should be aggregated
   * @example aggregateStoredTargetEmissions(emission => emission.date > moment().startOf('month').valueOf())
   *
   * @returns {Object[]} result
   * @returns {string} result[n].* All attributes of the target as defined in the settings doc
   * @returns {Integer} result[n].total The total number of unique target emission ids matching instanceFilter
   * @returns {Integer} result[n].pass The number of unique target emission ids matching instanceFilter with the latest emission with truthy "pass"
   * @returns {Integer} result[n].percent The percentage of pass/total
   */
  aggregateStoredTargetEmissions: targetEmissionFilter => targetState.aggregateStoredTargetEmissions(state.targetState, targetEmissionFilter),
};

const hashRulesConfig = (settingsDoc, userDoc) => {
  const settingsTasks = settingsDoc && settingsDoc.tasks || {};
  const settingsPermissions = settingsDoc && settingsDoc.permissions || {};
  const rulesConfig = {
    rules: settingsTasks.rules,
    targets: settingsTasks.targets,
    can_view_tasks: settingsPermissions.can_view_tasks,
    can_view_analytics: settingsPermissions.can_view_analytics,
    userDoc,
  };

  const asString = JSON.stringify(rulesConfig);
  return md5(asString);
};

const safeCallback = callback => (...args) => {
  if (callback && typeof callback === 'function') {
    return callback(...args);
  }
};

// ensure all exported functions are only ever called after initialization
module.exports = Object.keys(self).reduce((agg, key) => {
  agg[key] = (...args) => {
    if (!['build', 'load'].includes(key) && (!state || !state.contactState)) {
      throw Error(`Invalid operation: Attempted to invoke rules-state-store.${key} before call to build or load`);
    }

    return self[key](...args);
  };
  return agg;
}, {});