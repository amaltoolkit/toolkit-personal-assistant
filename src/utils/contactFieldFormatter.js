/**
 * Contact Field Formatter Utility
 * Formats contact fields for natural language responses
 * Handles both standard and custom fields with appropriate formatting
 */

const dayjs = require('dayjs');
const advancedFormat = require('dayjs/plugin/advancedFormat');
dayjs.extend(advancedFormat);

/**
 * Format ISO date string in human-readable format
 * @param {string} isoDateString - ISO date string (e.g., "1985-05-28T12:00:00.000Z")
 * @returns {string} - Formatted date (e.g., "May 28, 1985")
 */
function formatHumanReadableDate(isoDateString) {
  if (!isoDateString) return null;

  try {
    const date = dayjs(isoDateString);
    if (!date.isValid()) {
      console.warn(`[FIELD_FORMATTER] Invalid date: ${isoDateString}`);
      return isoDateString; // Return original if invalid
    }

    return date.format('MMMM D, YYYY');
  } catch (error) {
    console.error(`[FIELD_FORMATTER] Error formatting date: ${isoDateString}`, error);
    return isoDateString;
  }
}

/**
 * Format custom field values based on their type
 * Handles currency objects, dates, arrays, objects, and primitives
 * @param {any} value - The custom field value
 * @returns {string} - Formatted value
 */
function formatCustomFieldValue(value) {
  if (value === null || value === undefined) {
    return 'Not recorded';
  }

  // Handle currency objects (BSA format)
  if (typeof value === 'object' && value.ctype === 'USD' && value.value !== undefined) {
    return `$${Number(value.value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  // Handle other currency types
  if (typeof value === 'object' && value.ctype && value.value !== undefined) {
    return `${value.ctype} ${Number(value.value).toLocaleString()}`;
  }

  // Handle dates (ISO format strings)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const formattedDate = formatHumanReadableDate(value);
    if (formattedDate && formattedDate !== value) {
      return formattedDate;
    }
  }

  // Handle booleans
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  // Handle numbers
  if (typeof value === 'number') {
    // Format large numbers with commas
    if (value >= 1000) {
      return value.toLocaleString('en-US');
    }
    return String(value);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.length <= 3) {
      return value.join(', ');
    }
    return `${value.slice(0, 3).join(', ')} and ${value.length - 3} more`;
  }

  // Handle objects (convert to formatted JSON)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  // Handle strings and other primitives
  return String(value);
}

/**
 * Get friendly field name for display
 * Converts field names from various formats to human-readable labels
 * @param {string} fieldName - The field name (e.g., "birthDate", "coffee_preference")
 * @returns {string} - Friendly name (e.g., "birthday", "coffee preference")
 */
function getFriendlyFieldName(fieldName) {
  if (!fieldName) return 'information';

  // Predefined mappings for standard fields
  const friendlyNames = {
    // Personal
    birthDate: 'birthday',
    firstName: 'first name',
    lastName: 'last name',
    nickName: 'nickname',
    maritalStatus: 'marital status',
    anniversary: 'anniversary',

    // Contact
    email: 'email address',
    phone: 'phone number',
    mobile: 'mobile phone',
    fax: 'fax number',

    // Professional
    title: 'job title',
    jobTitle: 'job title',
    company: 'company',
    companyName: 'company',
    department: 'department',

    // Address
    address: 'address',
    addressLine1: 'address',
    city: 'city',
    state: 'state',
    postalCode: 'postal code',
    zipCode: 'zip code',
    country: 'country',

    // Other
    clientSince: 'client since',
    notes: 'notes',
    lastModified: 'last modified',
    createdDate: 'created date'
  };

  // Check if we have a predefined mapping
  if (friendlyNames[fieldName]) {
    return friendlyNames[fieldName];
  }

  // Convert camelCase to space-separated
  let friendly = fieldName.replace(/([A-Z])/g, ' $1').toLowerCase().trim();

  // Convert underscores to spaces
  friendly = friendly.replace(/_/g, ' ');

  // Capitalize first letter
  friendly = friendly.charAt(0).toUpperCase() + friendly.slice(1);

  return friendly;
}

/**
 * Format a complete contact summary with all available fields
 * @param {Object} contact - Contact object with all fields
 * @returns {string} - Formatted summary
 */
function formatContactSummary(contact) {
  if (!contact) return 'No contact information available';

  const lines = [];

  // Name and title
  if (contact.name) {
    let nameLine = `**${contact.name}**`;
    if (contact.title) {
      nameLine += ` - ${contact.title}`;
    }
    if (contact.company) {
      nameLine += ` at ${contact.company}`;
    }
    lines.push(nameLine);
  }

  // Contact information
  if (contact.email) lines.push(`📧 Email: ${contact.email}`);
  if (contact.phone) lines.push(`📞 Phone: ${contact.phone}`);
  if (contact.mobile) lines.push(`📱 Mobile: ${contact.mobile}`);

  // Address
  if (contact.address || contact.city || contact.state) {
    let addressLine = '📍 Location: ';
    const parts = [];
    if (contact.address) parts.push(contact.address);
    if (contact.city) parts.push(contact.city);
    if (contact.state) parts.push(contact.state);
    if (contact.postalCode) parts.push(contact.postalCode);
    addressLine += parts.join(', ');
    lines.push(addressLine);
  }

  // Personal information
  if (contact.birthDate) {
    lines.push(`🎂 Birthday: ${formatHumanReadableDate(contact.birthDate)}`);
  }
  if (contact.anniversary) {
    lines.push(`💍 Anniversary: ${formatHumanReadableDate(contact.anniversary)}`);
  }

  // Client information
  if (contact.clientSince) {
    lines.push(`👤 Client Since: ${formatHumanReadableDate(contact.clientSince)}`);
  }

  // Notes
  if (contact.notes) {
    lines.push(`📝 Notes: ${contact.notes}`);
  }

  return lines.join('\n');
}

module.exports = {
  formatHumanReadableDate,
  formatCustomFieldValue,
  getFriendlyFieldName,
  formatContactSummary
};
