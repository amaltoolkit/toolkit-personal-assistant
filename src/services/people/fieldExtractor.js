/**
 * Field Extractor for People Service
 *
 * Handles extraction of both standard and custom fields from users and contacts
 * Uses existing contactFieldFormatter for value formatting
 */

const { formatCustomFieldValue, getFriendlyFieldName } = require('../../utils/contactFieldFormatter');

/**
 * Standard field mappings for contacts
 */
const CONTACT_FIELD_MAP = {
  'email': 'email',
  'phone': 'phone',
  'mobile': 'mobile',
  'company': 'company',
  'title': 'title',
  'firstName': 'firstName',
  'first_name': 'firstName',
  'lastName': 'lastName',
  'last_name': 'lastName',
  'name': 'name',
  'fullName': 'name',
  'full_name': 'name',
  'birthday': 'birthDate',
  'birthdate': 'birthDate',
  'birth_date': 'birthDate',
  'address': 'address',
  'city': 'city',
  'state': 'state',
  'zip': 'zip',
  'country': 'country',
  'website': 'website',
  'notes': 'notes'
};

/**
 * Standard field mappings for users
 */
const USER_FIELD_MAP = {
  'email': 'email',
  'phone': 'phone',
  'mobile': 'mobile',
  'title': 'title',
  'job_title': 'title',
  'firstName': 'firstName',
  'first_name': 'firstName',
  'lastName': 'lastName',
  'last_name': 'lastName',
  'name': 'name',
  'fullName': 'name',
  'full_name': 'name',
  'department': 'department',
  'role': 'role',
  'manager': 'manager'
};

class FieldExtractor {
  /**
   * Extract field value from user or contact
   * @param {Object} person - User or contact object
   * @param {string} fieldName - Field name to extract
   * @param {string} type - 'user' or 'contact'
   * @returns {string} Formatted field value
   */
  extract(person, fieldName, type = 'contact') {
    if (!person) {
      throw new Error('Person object is required');
    }

    if (!fieldName) {
      throw new Error('Field name is required');
    }

    const fieldNameLower = fieldName.toLowerCase().trim();

    // Try standard fields first
    const fieldMap = type === 'user' ? USER_FIELD_MAP : CONTACT_FIELD_MAP;
    const mappedField = fieldMap[fieldNameLower];

    if (mappedField && person[mappedField] !== undefined) {
      const value = person[mappedField];
      return formatCustomFieldValue(value);
    }

    // Try direct property access (case-insensitive)
    const personKeys = Object.keys(person);
    const directMatch = personKeys.find(key => key.toLowerCase() === fieldNameLower);

    if (directMatch && person[directMatch] !== undefined) {
      const value = person[directMatch];
      return formatCustomFieldValue(value);
    }

    // For contacts, try custom fields (ExtendedProperties)
    if (type === 'contact' && person.ExtendedProperties) {
      return this.extractCustomField(person, fieldName);
    }

    // Field not found
    throw new Error(`Field "${fieldName}" not found on ${type}`);
  }

  /**
   * Extract custom field from contact's ExtendedProperties
   * Uses fuzzy matching to find the right field
   * @param {Object} contact - Contact object with ExtendedProperties
   * @param {string} fieldName - Field name to extract
   * @returns {string} Formatted field value
   */
  extractCustomField(contact, fieldName) {
    if (!contact.ExtendedProperties || contact.ExtendedProperties.length === 0) {
      throw new Error(`No custom fields available for contact`);
    }

    const fieldNameLower = fieldName.toLowerCase().trim();

    // Try exact match first
    let matchedField = contact.ExtendedProperties.find(prop =>
      prop.property_name.toLowerCase() === fieldNameLower
    );

    // Try fuzzy match
    if (!matchedField) {
      matchedField = contact.ExtendedProperties.find(prop =>
        prop.property_name.toLowerCase().includes(fieldNameLower) ||
        fieldNameLower.includes(prop.property_name.toLowerCase())
      );
    }

    if (!matchedField) {
      // List available custom fields in error
      const availableFields = contact.ExtendedProperties
        .map(p => p.property_name)
        .join(', ');

      throw new Error(
        `Custom field "${fieldName}" not found. Available custom fields: ${availableFields}`
      );
    }

    // Format the value
    const value = matchedField.property_value;
    return formatCustomFieldValue(value);
  }

  /**
   * Get all available fields for a person
   * @param {Object} person - User or contact object
   * @param {string} type - 'user' or 'contact'
   * @returns {Object} Map of field names to values
   */
  getAllFields(person, type = 'contact') {
    const fields = {};

    // Standard fields
    const fieldMap = type === 'user' ? USER_FIELD_MAP : CONTACT_FIELD_MAP;

    for (const [friendlyName, actualField] of Object.entries(fieldMap)) {
      if (person[actualField] !== undefined && person[actualField] !== null) {
        fields[friendlyName] = formatCustomFieldValue(person[actualField]);
      }
    }

    // Custom fields (contacts only)
    if (type === 'contact' && person.ExtendedProperties) {
      for (const prop of person.ExtendedProperties) {
        const friendlyName = getFriendlyFieldName(prop.property_name);
        fields[friendlyName] = formatCustomFieldValue(prop.property_value);
      }
    }

    return fields;
  }

  /**
   * Check if field exists on person
   * @param {Object} person - User or contact object
   * @param {string} fieldName - Field name
   * @param {string} type - 'user' or 'contact'
   * @returns {boolean}
   */
  hasField(person, fieldName, type = 'contact') {
    try {
      this.extract(person, fieldName, type);
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
let instance = null;

function getFieldExtractor() {
  if (!instance) {
    instance = new FieldExtractor();
  }
  return instance;
}

module.exports = {
  FieldExtractor,
  getFieldExtractor,
  CONTACT_FIELD_MAP,
  USER_FIELD_MAP
};
