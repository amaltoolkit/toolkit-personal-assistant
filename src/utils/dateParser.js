// Day.js date parser for natural language date queries
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const weekOfYear = require('dayjs/plugin/weekOfYear');
const quarterOfYear = require('dayjs/plugin/quarterOfYear');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const isoWeek = require('dayjs/plugin/isoWeek');
const advancedFormat = require('dayjs/plugin/advancedFormat');

// Load plugins
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(weekOfYear);
dayjs.extend(quarterOfYear);
dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);
dayjs.extend(advancedFormat);

/**
 * Parse natural language date queries into date ranges
 * @param {string} query - The natural language date query
 * @param {string} userTimezone - User's timezone (e.g., 'America/New_York')
 * @returns {Object|null} - { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', interpreted: string } or null
 */
function parseDateQuery(query, userTimezone = 'UTC') {
  // Normalize query to lowercase for matching
  const normalizedQuery = query.toLowerCase().trim();
  
  // Get current date in user's timezone
  const now = dayjs().tz(userTimezone);
  
  // Helper to format date as YYYY-MM-DD
  const formatDate = (date) => date.format('YYYY-MM-DD');
  
  // Single day patterns
  if (normalizedQuery === 'today') {
    const date = formatDate(now);
    return { 
      startDate: date, 
      endDate: date,
      interpreted: `Today (${date})`
    };
  }
  
  if (normalizedQuery === 'tomorrow') {
    const date = formatDate(now.add(1, 'day'));
    return { 
      startDate: date, 
      endDate: date,
      interpreted: `Tomorrow (${date})`
    };
  }
  
  if (normalizedQuery === 'yesterday') {
    const date = formatDate(now.subtract(1, 'day'));
    return { 
      startDate: date, 
      endDate: date,
      interpreted: `Yesterday (${date})`
    };
  }
  
  // Week patterns (Monday to Sunday)
  if (normalizedQuery === 'this week' || normalizedQuery === 'current week') {
    const startOfWeek = now.startOf('isoWeek'); // Monday
    const endOfWeek = now.endOf('isoWeek'); // Sunday
    return {
      startDate: formatDate(startOfWeek),
      endDate: formatDate(endOfWeek),
      interpreted: `This week (${formatDate(startOfWeek)} to ${formatDate(endOfWeek)})`
    };
  }
  
  if (normalizedQuery === 'last week' || normalizedQuery === 'previous week') {
    const lastWeek = now.subtract(1, 'week');
    const startOfWeek = lastWeek.startOf('isoWeek');
    const endOfWeek = lastWeek.endOf('isoWeek');
    return {
      startDate: formatDate(startOfWeek),
      endDate: formatDate(endOfWeek),
      interpreted: `Last week (${formatDate(startOfWeek)} to ${formatDate(endOfWeek)})`
    };
  }
  
  if (normalizedQuery === 'next week') {
    const nextWeek = now.add(1, 'week');
    const startOfWeek = nextWeek.startOf('isoWeek');
    const endOfWeek = nextWeek.endOf('isoWeek');
    return {
      startDate: formatDate(startOfWeek),
      endDate: formatDate(endOfWeek),
      interpreted: `Next week (${formatDate(startOfWeek)} to ${formatDate(endOfWeek)})`
    };
  }
  
  // Month patterns
  if (normalizedQuery === 'this month' || normalizedQuery === 'current month') {
    const startOfMonth = now.startOf('month');
    const endOfMonth = now.endOf('month');
    return {
      startDate: formatDate(startOfMonth),
      endDate: formatDate(endOfMonth),
      interpreted: `This month (${now.format('MMMM YYYY')})`
    };
  }
  
  if (normalizedQuery === 'last month' || normalizedQuery === 'previous month') {
    const lastMonth = now.subtract(1, 'month');
    const startOfMonth = lastMonth.startOf('month');
    const endOfMonth = lastMonth.endOf('month');
    return {
      startDate: formatDate(startOfMonth),
      endDate: formatDate(endOfMonth),
      interpreted: `Last month (${lastMonth.format('MMMM YYYY')})`
    };
  }
  
  if (normalizedQuery === 'next month') {
    const nextMonth = now.add(1, 'month');
    const startOfMonth = nextMonth.startOf('month');
    const endOfMonth = nextMonth.endOf('month');
    return {
      startDate: formatDate(startOfMonth),
      endDate: formatDate(endOfMonth),
      interpreted: `Next month (${nextMonth.format('MMMM YYYY')})`
    };
  }
  
  // Quarter patterns
  if (normalizedQuery === 'this quarter' || normalizedQuery === 'current quarter') {
    const startOfQuarter = now.startOf('quarter');
    const endOfQuarter = now.endOf('quarter');
    return {
      startDate: formatDate(startOfQuarter),
      endDate: formatDate(endOfQuarter),
      interpreted: `Q${now.quarter()} ${now.year()} (${formatDate(startOfQuarter)} to ${formatDate(endOfQuarter)})`
    };
  }
  
  if (normalizedQuery === 'last quarter' || normalizedQuery === 'previous quarter') {
    const lastQuarter = now.subtract(1, 'quarter');
    const startOfQuarter = lastQuarter.startOf('quarter');
    const endOfQuarter = lastQuarter.endOf('quarter');
    return {
      startDate: formatDate(startOfQuarter),
      endDate: formatDate(endOfQuarter),
      interpreted: `Q${lastQuarter.quarter()} ${lastQuarter.year()} (${formatDate(startOfQuarter)} to ${formatDate(endOfQuarter)})`
    };
  }
  
  if (normalizedQuery === 'next quarter') {
    const nextQuarter = now.add(1, 'quarter');
    const startOfQuarter = nextQuarter.startOf('quarter');
    const endOfQuarter = nextQuarter.endOf('quarter');
    return {
      startDate: formatDate(startOfQuarter),
      endDate: formatDate(endOfQuarter),
      interpreted: `Q${nextQuarter.quarter()} ${nextQuarter.year()} (${formatDate(startOfQuarter)} to ${formatDate(endOfQuarter)})`
    };
  }
  
  // Year patterns
  if (normalizedQuery === 'this year' || normalizedQuery === 'current year') {
    const startOfYear = now.startOf('year');
    const endOfYear = now.endOf('year');
    return {
      startDate: formatDate(startOfYear),
      endDate: formatDate(endOfYear),
      interpreted: `${now.year()} (entire year)`
    };
  }
  
  if (normalizedQuery === 'last year' || normalizedQuery === 'previous year') {
    const lastYear = now.subtract(1, 'year');
    const startOfYear = lastYear.startOf('year');
    const endOfYear = lastYear.endOf('year');
    return {
      startDate: formatDate(startOfYear),
      endDate: formatDate(endOfYear),
      interpreted: `${lastYear.year()} (entire year)`
    };
  }
  
  if (normalizedQuery === 'next year') {
    const nextYear = now.add(1, 'year');
    const startOfYear = nextYear.startOf('year');
    const endOfYear = nextYear.endOf('year');
    return {
      startDate: formatDate(startOfYear),
      endDate: formatDate(endOfYear),
      interpreted: `${nextYear.year()} (entire year)`
    };
  }
  
  // Relative day patterns (next/past X days)
  const nextDaysMatch = normalizedQuery.match(/^next (\d+) days?$/);
  if (nextDaysMatch) {
    const days = parseInt(nextDaysMatch[1], 10);
    const startDate = formatDate(now.add(1, 'day')); // Start from tomorrow
    const endDate = formatDate(now.add(days, 'day'));
    return {
      startDate,
      endDate,
      interpreted: `Next ${days} day${days > 1 ? 's' : ''} (${startDate} to ${endDate})`
    };
  }
  
  const pastDaysMatch = normalizedQuery.match(/^(?:past|last) (\d+) days?$/);
  if (pastDaysMatch) {
    const days = parseInt(pastDaysMatch[1], 10);
    const startDate = formatDate(now.subtract(days, 'day'));
    const endDate = formatDate(now.subtract(1, 'day')); // End at yesterday
    return {
      startDate,
      endDate,
      interpreted: `Past ${days} day${days > 1 ? 's' : ''} (${startDate} to ${endDate})`
    };
  }
  
  // Weekend patterns
  if (normalizedQuery === 'this weekend') {
    const saturday = now.day(6); // Saturday
    const sunday = now.day(7); // Sunday
    // If it's already past this weekend, get next weekend
    if (now.day() === 0) { // Sunday
      return {
        startDate: formatDate(now.day(6)),
        endDate: formatDate(now),
        interpreted: `This weekend (${formatDate(now.day(6))} to ${formatDate(now)})`
      };
    } else if (now.day() === 6) { // Saturday
      return {
        startDate: formatDate(now),
        endDate: formatDate(now.add(1, 'day')),
        interpreted: `This weekend (${formatDate(now)} to ${formatDate(now.add(1, 'day'))})`
      };
    } else if (now.day() < 6) { // Monday-Friday
      const thisSaturday = now.day(6);
      const thisSunday = now.day(7);
      return {
        startDate: formatDate(thisSaturday),
        endDate: formatDate(thisSunday),
        interpreted: `This weekend (${formatDate(thisSaturday)} to ${formatDate(thisSunday)})`
      };
    }
  }
  
  if (normalizedQuery === 'next weekend') {
    const nextWeek = now.add(1, 'week');
    const saturday = nextWeek.day(6);
    const sunday = nextWeek.day(7);
    return {
      startDate: formatDate(saturday),
      endDate: formatDate(sunday),
      interpreted: `Next weekend (${formatDate(saturday)} to ${formatDate(sunday)})`
    };
  }
  
  if (normalizedQuery === 'last weekend') {
    const lastWeek = now.subtract(1, 'week');
    const saturday = lastWeek.day(6);
    const sunday = lastWeek.day(7);
    return {
      startDate: formatDate(saturday),
      endDate: formatDate(sunday),
      interpreted: `Last weekend (${formatDate(saturday)} to ${formatDate(sunday)})`
    };
  }
  
  // Day of week patterns (e.g., "this monday", "next friday")
  const daysOfWeek = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const dayMap = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
  
  for (const day of daysOfWeek) {
    if (normalizedQuery === `this ${day}`) {
      const targetDay = now.day(dayMap[day]);
      const date = formatDate(targetDay);
      return {
        startDate: date,
        endDate: date,
        interpreted: `This ${day.charAt(0).toUpperCase() + day.slice(1)} (${date})`
      };
    }
    
    if (normalizedQuery === `next ${day}`) {
      // Use dayjs overflow: day number + 7 = next week's day
      const targetDay = now.day(dayMap[day] + 7);
      const date = formatDate(targetDay);
      return {
        startDate: date,
        endDate: date,
        interpreted: `Next ${day.charAt(0).toUpperCase() + day.slice(1)} (${date})`
      };
    }
    
    if (normalizedQuery === `last ${day}`) {
      // Use dayjs overflow: day number - 7 = last week's day
      const targetDay = now.day(dayMap[day] - 7);
      const date = formatDate(targetDay);
      return {
        startDate: date,
        endDate: date,
        interpreted: `Last ${day.charAt(0).toUpperCase() + day.slice(1)} (${date})`
      };
    }
  }
  
  // Helper to normalize date strings for parsing (capitalize months, lowercase ordinals)
  const normalizeDateString = (str) => {
    // First, lowercase ordinal suffixes (1ST -> 1st, 2ND -> 2nd, etc.)
    let result = str.replace(/(\d+)(ST|ND|RD|TH)/gi, (match, num, suffix) => {
      return num + suffix.toLowerCase();
    });

    // Then capitalize month names
    const months = ['january', 'february', 'march', 'april', 'may', 'june',
                    'july', 'august', 'september', 'october', 'november', 'december',
                    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
                    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

    months.forEach(month => {
      const regex = new RegExp(`\\b${month}\\b`, 'gi');
      result = result.replace(regex, match =>
        match.charAt(0).toUpperCase() + match.slice(1).toLowerCase()
      );
    });

    return result;
  };

  // Check if it's a specific date in various formats
  const dateFormats = [
    'YYYY-MM-DD',
    'MM/DD/YYYY',
    'DD/MM/YYYY',
    'MMM DD, YYYY',
    'DD MMM YYYY',
    'MMMM DD, YYYY',
    'DD MMMM YYYY',
    // Ordinal formats (Day.js handles these with customParseFormat plugin)
    'MMM Do',        // "Sep 17th"
    'MMMM Do',       // "September 17th"
    'Do MMM',        // "17th Sep"
    'Do MMMM',       // "17th September"
    'MMM Do, YYYY',  // "Sep 17th, 2025"
    'MMMM Do, YYYY', // "September 17th, 2025"
    'Do MMM YYYY',   // "17th Sep 2025"
    'Do MMMM YYYY'   // "17th September 2025"
  ];
  
  for (const format of dateFormats) {
    // Try parsing with original case first, then with capitalized months
    const parsed = dayjs(query.trim(), format, true);
    if (parsed.isValid()) {
      const date = formatDate(parsed);
      return {
        startDate: date,
        endDate: date,
        interpreted: `${parsed.format('MMMM D, YYYY')} (${date})`
      };
    }

    // If that fails, try with normalized date string
    const normalizedQuery = normalizeDateString(query.trim());
    const parsedCapitalized = dayjs(normalizedQuery, format, true);
    if (parsedCapitalized.isValid()) {
      const date = formatDate(parsedCapitalized);
      return {
        startDate: date,
        endDate: date,
        interpreted: `${parsedCapitalized.format('MMMM D, YYYY')} (${date})`
      };
    }
  }
  
  // No match found
  return null;
}

/**
 * Extract date information from a complex query
 * @param {string} query - The full query text
 * @param {string} userTimezone - User's timezone
 * @returns {Object} - { dateRange: {startDate, endDate, interpreted}, cleanQuery: string }
 */
function extractDateFromQuery(query, userTimezone = 'UTC') {
  // Common date-related keywords to look for
  const datePatterns = [
    'today', 'tomorrow', 'yesterday',
    'this week', 'last week', 'next week',
    'this month', 'last month', 'next month',
    'this quarter', 'last quarter', 'next quarter',
    'this year', 'last year', 'next year',
    'this weekend', 'last weekend', 'next weekend',
    'current week', 'current month', 'current quarter', 'current year',
    'previous week', 'previous month', 'previous quarter', 'previous year'
  ];
  
  // Also check for relative patterns
  const relativePatterns = [
    /next \d+ days?/,
    /past \d+ days?/,
    /last \d+ days?/
  ];
  
  // Day of week patterns
  const dayPatterns = [
    'this monday', 'this tuesday', 'this wednesday', 'this thursday', 
    'this friday', 'this saturday', 'this sunday',
    'next monday', 'next tuesday', 'next wednesday', 'next thursday',
    'next friday', 'next saturday', 'next sunday',
    'last monday', 'last tuesday', 'last wednesday', 'last thursday',
    'last friday', 'last saturday', 'last sunday'
  ];
  
  const lowerQuery = query.toLowerCase();
  
  // Check for exact date patterns first
  for (const pattern of [...datePatterns, ...dayPatterns]) {
    if (lowerQuery.includes(pattern)) {
      const dateRange = parseDateQuery(pattern, userTimezone);
      if (dateRange) {
        // Remove the date pattern from the query
        const cleanQuery = query.replace(new RegExp(pattern, 'gi'), '').trim();
        return {
          dateRange,
          cleanQuery
        };
      }
    }
  }
  
  // Check relative patterns
  for (const pattern of relativePatterns) {
    const match = lowerQuery.match(pattern);
    if (match) {
      const dateRange = parseDateQuery(match[0], userTimezone);
      if (dateRange) {
        const cleanQuery = query.replace(new RegExp(match[0], 'gi'), '').trim();
        return {
          dateRange,
          cleanQuery
        };
      }
    }
  }
  
  return {
    dateRange: null,
    cleanQuery: query
  };
}

/**
 * Extract time from a date query string
 * @param {string} dateQuery - Query containing time expression
 * @returns {Object} - { hour, minute, hasTime } or { hasTime: false }
 */
function extractTimeFromDateQuery(dateQuery) {
  // Match various time patterns
  // Handles: 8am, 8:30am, 8 am, 8:30 am, 8PM, 8:30PM, etc.
  const timeMatch = dateQuery.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)/i);

  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const meridiem = timeMatch[3]?.toLowerCase();

    // Convert to 24-hour format
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    // Validate hour and minute
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute, hasTime: true };
    }
  }

  // Check for special time words
  if (/\bnoon\b/i.test(dateQuery)) {
    return { hour: 12, minute: 0, hasTime: true };
  }
  if (/\bmidnight\b/i.test(dateQuery)) {
    return { hour: 0, minute: 0, hasTime: true };
  }

  return { hasTime: false };
}

/**
 * Parse natural language date and time queries into ISO timestamps
 * @param {string} query - Natural language date/time query (e.g., "tomorrow at 8am")
 * @param {string} userTimezone - User's timezone (e.g., 'America/New_York')
 * @returns {Object|null} - { startDateTime, endDateTime, dateComponent, timeComponent, interpreted }
 */
function parseDateTimeQuery(query, userTimezone = 'UTC') {
  if (!query) return null;

  // Step 1: Extract date part by removing time patterns
  const datePartOnly = query
    .replace(/\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)/gi, '')
    .replace(/\s+at\s+noon/gi, '')
    .replace(/\s+at\s+midnight/gi, '')
    .trim();

  // Step 2: Parse the date part using existing function
  const dateResult = parseDateQuery(datePartOnly, userTimezone);
  if (!dateResult) {
    console.log(`[dateParser] Could not parse date from: "${datePartOnly}"`);
    return null;
  }

  // Step 3: Extract time component
  const timeResult = extractTimeFromDateQuery(query);

  // Step 4: Combine date and time if time was found
  if (timeResult.hasTime) {
    // Use dayjs with timezone to create the full datetime
    const startDateTime = dayjs.tz(dateResult.startDate, userTimezone)
      .hour(timeResult.hour)
      .minute(timeResult.minute)
      .second(0)
      .millisecond(0);

    const timeString = `${timeResult.hour % 12 || 12}:${String(timeResult.minute).padStart(2, '0')} ${timeResult.hour >= 12 ? 'PM' : 'AM'}`;

    return {
      startDateTime: startDateTime.toISOString(),
      endDateTime: null, // Let caller determine duration
      dateComponent: dateResult,
      timeComponent: timeResult,
      interpreted: `${dateResult.interpreted} at ${timeString}`,
      hasTime: true
    };
  }

  // No time found, return date-only result
  return {
    startDateTime: null,
    endDateTime: null,
    dateComponent: dateResult,
    timeComponent: null,
    interpreted: dateResult.interpreted,
    hasTime: false
  };
}

/**
 * Create end time based on start time and duration
 * @param {string} startDateTime - ISO format start time
 * @param {number} durationMinutes - Duration in minutes (default 60)
 * @returns {string} - ISO format end time
 */
function calculateEndTime(startDateTime, durationMinutes = 60) {
  return dayjs(startDateTime).add(durationMinutes, 'minute').toISOString();
}

module.exports = {
  parseDateQuery,
  extractDateFromQuery,
  extractTimeFromDateQuery,
  parseDateTimeQuery,
  calculateEndTime
};