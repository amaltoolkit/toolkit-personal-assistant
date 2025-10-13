/**
 * Chrono-based Natural Language Date Parser
 *
 * Replaces the complex dateParser.js with Chrono.js for better natural language support.
 * Maintains backward compatibility while adding enhanced capabilities.
 */

const chrono = require('chrono-node');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
const quarterOfYear = require('dayjs/plugin/quarterOfYear');

// Load Day.js plugins
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);
dayjs.extend(quarterOfYear);

/**
 * Parse natural language date queries into date ranges
 * Compatible with existing dateParser.js API
 *
 * @param {string} query - Natural language date query
 * @param {string} userTimezone - User's timezone (e.g., 'America/New_York')
 * @returns {Object|null} - { startDate, endDate, interpreted } or null
 */
function parseDateQuery(query, userTimezone = 'UTC') {
  if (!query) return null;

  // Special handling for date ranges
  const rangePatterns = {
    'this week': () => getWeekRange(userTimezone),
    'current week': () => getWeekRange(userTimezone),
    'next week': () => getNextWeekRange(userTimezone),
    'last week': () => getLastWeekRange(userTimezone),
    'previous week': () => getLastWeekRange(userTimezone),
    'this month': () => getMonthRange(userTimezone),
    'current month': () => getMonthRange(userTimezone),
    'next month': () => getNextMonthRange(userTimezone),
    'last month': () => getLastMonthRange(userTimezone),
    'previous month': () => getLastMonthRange(userTimezone),
    'this quarter': () => getQuarterRange(userTimezone),
    'current quarter': () => getQuarterRange(userTimezone),
    'next quarter': () => getNextQuarterRange(userTimezone),
    'last quarter': () => getLastQuarterRange(userTimezone),
    'this year': () => getYearRange(userTimezone),
    'current year': () => getYearRange(userTimezone),
    'next year': () => getNextYearRange(userTimezone),
    'last year': () => getLastYearRange(userTimezone),
    'this weekend': () => getWeekendRange(userTimezone),
    'next weekend': () => getNextWeekendRange(userTimezone),
    'last weekend': () => getLastWeekendRange(userTimezone)
  };

  const normalized = query.toLowerCase().trim();
  if (rangePatterns[normalized]) {
    return rangePatterns[normalized]();
  }

  // Check for month/year patterns like "October 2025", "September", etc.
  // These should be treated as full month ranges, not single days
  const monthYearPattern = /^(january|february|march|april|may|june|july|august|september|october|november|december)(\s+\d{4})?$/i;
  const monthMatch = query.match(monthYearPattern);

  if (monthMatch) {
    const monthName = monthMatch[1];
    const year = monthMatch[2] ? parseInt(monthMatch[2].trim()) : dayjs().tz(userTimezone).year();

    // Parse the month name to get month index (0-11)
    const monthDate = dayjs(`${year}-${monthName}-01`, 'YYYY-MMMM-DD').tz(userTimezone);
    const startDate = monthDate.startOf('month');
    const endDate = monthDate.endOf('month');

    return {
      startDate: startDate.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      interpreted: `${monthDate.format('MMMM YYYY')} (full month: ${startDate.format('YYYY-MM-DD')} to ${endDate.format('YYYY-MM-DD')})`
    };
  }

  // Use Chrono for natural language parsing
  // Create reference date in user's timezone to avoid timezone conversion issues
  const now = dayjs().tz(userTimezone);
  const referenceDate = new Date(
    now.year(),
    now.month(),
    now.date(),
    now.hour(),
    now.minute(),
    now.second()
  );
  const parsed = chrono.parseDate(query, referenceDate, {
    timezone: userTimezone
  });

  if (parsed) {
    const date = dayjs(parsed).tz(userTimezone).format('YYYY-MM-DD');
    return {
      startDate: date,
      endDate: date,
      interpreted: dayjs(parsed).tz(userTimezone).format('MMMM D, YYYY') + ` (${date})`
    };
  }

  return null;
}

/**
 * Parse natural language date and time queries into ISO timestamps
 * Compatible with existing dateParser.js API
 *
 * @param {string} query - Natural language date/time query
 * @param {string} userTimezone - User's timezone
 * @returns {Object|null} - { startDateTime, endDateTime, dateComponent, timeComponent, interpreted, hasTime }
 */
function parseDateTimeQuery(query, userTimezone = 'UTC') {
  if (!query) return null;

  // Create reference date in user's timezone to avoid timezone conversion issues
  const now = dayjs().tz(userTimezone);
  const referenceDate = new Date(
    now.year(),
    now.month(),
    now.date(),
    now.hour(),
    now.minute(),
    now.second()
  );
  const results = chrono.parse(query, referenceDate, {
    timezone: userTimezone
  });

  if (results.length > 0) {
    const parsed = results[0];
    const startDateTime = parsed.start.date();

    // Check if time was explicitly mentioned
    const hasTime = parsed.start.knownValues.hour !== undefined;

    // If the user didn't specify an explicit timezone, interpret the parsed
    // components as local time in the user's timezone (keepLocalTime=true).
    // Otherwise, convert normally.
    const hasExplicitTZ = !!(parsed.start.knownValues && parsed.start.knownValues.timezoneOffset !== undefined);
    const startMoment = hasExplicitTZ
      ? dayjs(startDateTime).tz(userTimezone)
      : dayjs(startDateTime).tz(userTimezone, true);

    return {
      startDateTime: startMoment.toISOString(),
      endDateTime: null, // Let caller determine duration
      dateComponent: {
        startDate: startMoment.format('YYYY-MM-DD'),
        endDate: startMoment.format('YYYY-MM-DD'),
        interpreted: startMoment.format('MMMM D, YYYY')
      },
      timeComponent: hasTime ? {
        hour: startMoment.hour(),
        minute: startMoment.minute(),
        hasTime: true
      } : {
        hasTime: false
      },
      interpreted: formatInterpretation(parsed, startMoment, hasTime),
      hasTime: hasTime
    };
  }

  return null;
}

/**
 * Parse task due dates with smart defaults
 * NEW function for enhanced task management
 *
 * @param {string} query - Natural language due date
 * @param {string} userTimezone - User's timezone
 * @returns {string|null} - YYYY-MM-DD format date or null
 */
function parseTaskDueDate(query, userTimezone = 'UTC') {
  if (!query) return null;

  // Handle urgent/EOD patterns
  const urgentPatterns = {
    'urgent': 'today at 5pm',
    'asap': 'today at 5pm',
    'eod': 'today at 5pm',
    'end of day': 'today at 5pm',
    'cob': 'today at 5pm',
    'close of business': 'today at 5pm',
    'eow': 'friday at 5pm',
    'end of week': 'friday at 5pm'
  };

  const normalized = query.toLowerCase();
  for (const [pattern, chronoQuery] of Object.entries(urgentPatterns)) {
    if (normalized.includes(pattern)) {
      const referenceDate = dayjs().tz(userTimezone).toDate();
      const parsed = chrono.parseDate(chronoQuery, referenceDate, {
        timezone: userTimezone
      });
      if (parsed) {
        return dayjs(parsed).tz(userTimezone).format('YYYY-MM-DD');
      }
    }
  }

  // Use Chrono with forward date preference for tasks
  const referenceDate = dayjs().tz(userTimezone).toDate();
  const parsed = chrono.parseDate(query, referenceDate, {
    timezone: userTimezone,
    forwardDate: true  // Prefer future dates for tasks
  });

  if (parsed) {
    return dayjs(parsed).tz(userTimezone).format('YYYY-MM-DD');
  }

  return null;
}

/**
 * Parse workflow timelines and milestones
 * NEW function for workflow management
 *
 * @param {string} query - Text containing timeline/milestone dates
 * @param {string} userTimezone - User's timezone
 * @returns {Array|null} - Array of milestone objects or null
 */
function parseWorkflowTimeline(query, userTimezone = 'UTC') {
  if (!query) return null;

  const referenceDate = dayjs().tz(userTimezone).toDate();
  const dates = chrono.parse(query, referenceDate, {
    timezone: userTimezone
  });

  if (dates.length === 0) return null;

  const milestones = dates.map(d => ({
    text: d.text,
    date: dayjs(d.start.date()).tz(userTimezone).format('YYYY-MM-DD'),
    hasTime: d.start.knownValues.hour !== undefined,
    interpreted: dayjs(d.start.date()).tz(userTimezone).format('MMM D, YYYY')
  }));

  return milestones;
}

/**
 * Calculate end time based on start time and duration
 * Kept for backward compatibility
 *
 * @param {string} startDateTime - ISO format start time
 * @param {number} durationMinutes - Duration in minutes (default 60)
 * @returns {string} - ISO format end time
 */
function calculateEndTime(startDateTime, durationMinutes = 60) {
  return dayjs(startDateTime).add(durationMinutes, 'minute').toISOString();
}

/**
 * Extract date information from a complex query
 * Kept for backward compatibility
 *
 * @param {string} query - The full query text
 * @param {string} userTimezone - User's timezone
 * @returns {Object} - { dateRange, cleanQuery }
 */
function extractDateFromQuery(query, userTimezone = 'UTC') {
  if (!query) return { dateRange: null, cleanQuery: query };

  // Try to parse the date
  const dateRange = parseDateQuery(query, userTimezone);

  if (dateRange) {
    // Remove the date part from the query (simplified approach)
    // Chrono handles this better internally
    return {
      dateRange,
      cleanQuery: query
    };
  }

  return {
    dateRange: null,
    cleanQuery: query
  };
}

/**
 * Extract time from a date query string
 * Kept for backward compatibility
 *
 * @param {string} dateQuery - Query containing time expression
 * @returns {Object} - { hour, minute, hasTime } or { hasTime: false }
 */
function extractTimeFromDateQuery(dateQuery) {
  if (!dateQuery) return { hasTime: false };

  const parsed = chrono.parseDate(dateQuery);
  if (parsed) {
    const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
    return hasTime ? {
      hour: parsed.getHours(),
      minute: parsed.getMinutes(),
      hasTime: true
    } : {
      hasTime: false
    };
  }

  return { hasTime: false };
}

// Helper functions for date ranges
function getWeekRange(tz) {
  const start = dayjs().tz(tz).startOf('isoWeek');
  const end = dayjs().tz(tz).endOf('isoWeek');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `This week (${start.format('MMM D')} - ${end.format('MMM D, YYYY')})`
  };
}

function getNextWeekRange(tz) {
  const start = dayjs().tz(tz).add(1, 'week').startOf('isoWeek');
  const end = dayjs().tz(tz).add(1, 'week').endOf('isoWeek');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Next week (${start.format('MMM D')} - ${end.format('MMM D, YYYY')})`
  };
}

function getLastWeekRange(tz) {
  const start = dayjs().tz(tz).subtract(1, 'week').startOf('isoWeek');
  const end = dayjs().tz(tz).subtract(1, 'week').endOf('isoWeek');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Last week (${start.format('MMM D')} - ${end.format('MMM D, YYYY')})`
  };
}

function getMonthRange(tz) {
  const start = dayjs().tz(tz).startOf('month');
  const end = dayjs().tz(tz).endOf('month');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `This month (${start.format('MMMM YYYY')})`
  };
}

function getNextMonthRange(tz) {
  const start = dayjs().tz(tz).add(1, 'month').startOf('month');
  const end = dayjs().tz(tz).add(1, 'month').endOf('month');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Next month (${start.format('MMMM YYYY')})`
  };
}

function getLastMonthRange(tz) {
  const start = dayjs().tz(tz).subtract(1, 'month').startOf('month');
  const end = dayjs().tz(tz).subtract(1, 'month').endOf('month');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Last month (${start.format('MMMM YYYY')})`
  };
}

function getQuarterRange(tz) {
  const start = dayjs().tz(tz).startOf('quarter');
  const end = dayjs().tz(tz).endOf('quarter');
  const quarter = Math.floor(start.month() / 3) + 1;
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Q${quarter} ${start.year()} (${start.format('MMM D')} - ${end.format('MMM D, YYYY')})`
  };
}

function getNextQuarterRange(tz) {
  const start = dayjs().tz(tz).add(1, 'quarter').startOf('quarter');
  const end = dayjs().tz(tz).add(1, 'quarter').endOf('quarter');
  const quarter = Math.floor(start.month() / 3) + 1;
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Q${quarter} ${start.year()} (${start.format('MMM D')} - ${end.format('MMM D, YYYY')})`
  };
}

function getLastQuarterRange(tz) {
  const start = dayjs().tz(tz).subtract(1, 'quarter').startOf('quarter');
  const end = dayjs().tz(tz).subtract(1, 'quarter').endOf('quarter');
  const quarter = Math.floor(start.month() / 3) + 1;
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `Q${quarter} ${start.year()} (${start.format('MMM D')} - ${end.format('MMM D, YYYY')})`
  };
}

function getYearRange(tz) {
  const start = dayjs().tz(tz).startOf('year');
  const end = dayjs().tz(tz).endOf('year');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `${start.year()} (entire year)`
  };
}

function getNextYearRange(tz) {
  const start = dayjs().tz(tz).add(1, 'year').startOf('year');
  const end = dayjs().tz(tz).add(1, 'year').endOf('year');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `${start.year()} (entire year)`
  };
}

function getLastYearRange(tz) {
  const start = dayjs().tz(tz).subtract(1, 'year').startOf('year');
  const end = dayjs().tz(tz).subtract(1, 'year').endOf('year');
  return {
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    interpreted: `${start.year()} (entire year)`
  };
}

function getWeekendRange(tz) {
  const now = dayjs().tz(tz);
  let saturday, sunday;

  if (now.day() === 6) { // Saturday
    saturday = now;
    sunday = now.add(1, 'day');
  } else if (now.day() === 0) { // Sunday
    saturday = now.subtract(1, 'day');
    sunday = now;
  } else { // Weekday
    saturday = now.day(6);
    sunday = now.day(7);
  }

  return {
    startDate: saturday.format('YYYY-MM-DD'),
    endDate: sunday.format('YYYY-MM-DD'),
    interpreted: `This weekend (${saturday.format('MMM D')} - ${sunday.format('MMM D, YYYY')})`
  };
}

function getNextWeekendRange(tz) {
  const saturday = dayjs().tz(tz).add(1, 'week').day(6);
  const sunday = dayjs().tz(tz).add(1, 'week').day(7);

  return {
    startDate: saturday.format('YYYY-MM-DD'),
    endDate: sunday.format('YYYY-MM-DD'),
    interpreted: `Next weekend (${saturday.format('MMM D')} - ${sunday.format('MMM D, YYYY')})`
  };
}

function getLastWeekendRange(tz) {
  const saturday = dayjs().tz(tz).subtract(1, 'week').day(6);
  const sunday = dayjs().tz(tz).subtract(1, 'week').day(7);

  return {
    startDate: saturday.format('YYYY-MM-DD'),
    endDate: sunday.format('YYYY-MM-DD'),
    interpreted: `Last weekend (${saturday.format('MMM D')} - ${sunday.format('MMM D, YYYY')})`
  };
}

// Helper to format interpretation string
function formatInterpretation(parsed, momentDate, hasTime) {
  const dateStr = momentDate.format('MMMM D, YYYY');

  if (hasTime) {
    const timeStr = momentDate.format('h:mm A');
    return `${dateStr} at ${timeStr}`;
  }

  return dateStr;
}

// Export all functions
module.exports = {
  // Main API (backward compatible)
  parseDateQuery,
  parseDateTimeQuery,
  calculateEndTime,
  extractDateFromQuery,
  extractTimeFromDateQuery,

  // New enhanced functions
  parseTaskDueDate,
  parseWorkflowTimeline
};
