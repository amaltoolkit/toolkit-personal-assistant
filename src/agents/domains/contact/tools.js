/**
 * Contact Tools for LLM Tool-Calling
 *
 * These tools wrap PeopleService methods and are designed to be used
 * with LangChain's tool-calling pattern. They accept runtime context
 * via the config parameter.
 *
 * IMPORTANT: Disambiguation errors (NeedsClarification, PersonNotFound)
 * are re-thrown to be handled by the Contact Agent's handleQuery node.
 */

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { getPeopleService } = require("../../../services/people");
const { NeedsClarification, PersonNotFound } = require("../../../services/people/errors");

/**
 * Search for contacts by name
 * Returns array of matching contacts with basic info
 * Throws NeedsClarification if multiple matches found
 */
const searchContactsTool = tool(
  async ({ query }, config) => {
    console.log(`[TOOL:SEARCH_CONTACTS] Searching for: "${query}"`);

    try {
      const context = config.context;
      if (!context) {
        throw new Error("Context is required for tool execution");
      }

      const peopleService = getPeopleService();
      const results = await peopleService.resolveContacts([query], context);

      console.log(`[TOOL:SEARCH_CONTACTS] Found ${results.length} contacts`);

      // Return simplified contact list
      const simplified = results.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        company: c.company,
        title: c.title
      }));

      return JSON.stringify(simplified, null, 2);
    } catch (error) {
      // Re-throw disambiguation errors so handleQuery can catch them
      if (error instanceof NeedsClarification || error instanceof PersonNotFound) {
        throw error;
      }

      console.error("[TOOL:SEARCH_CONTACTS] Error:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
  {
    name: "search_contacts",
    description: "Search for contacts in the CRM by name. Returns array of matching contacts with basic info (id, name, email, company, title). Use get_contact_details to fetch complete information including custom fields.",
    schema: z.object({
      query: z.string().describe("Name to search for (can be partial, e.g. 'Norm' or 'Norman Albertson')")
    })
  }
);

/**
 * Get full contact details including custom fields (ExtendedProperties)
 * Use this after finding a contact with search_contacts
 */
const getContactDetailsTool = tool(
  async ({ personName }, config) => {
    console.log(`[TOOL:GET_CONTACT] Fetching details for: "${personName}"`);

    try {
      const context = config.context;
      if (!context) {
        throw new Error("Context is required for tool execution");
      }

      const peopleService = getPeopleService();
      const contact = await peopleService.getDetails(personName, 'contact', context);

      console.log(`[TOOL:GET_CONTACT] Retrieved contact: ${contact.name}`);

      // Format custom fields for easier reading
      const formattedContact = {
        ...contact,
        customFields: contact.ExtendedProperties?.map(prop => ({
          name: prop.property_name,
          value: prop.property_value
        })) || []
      };

      // Return full contact object (includes ExtendedProperties)
      return JSON.stringify(formattedContact, null, 2);
    } catch (error) {
      // Re-throw disambiguation errors
      if (error instanceof NeedsClarification || error instanceof PersonNotFound) {
        throw error;
      }

      console.error("[TOOL:GET_CONTACT] Error:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
  {
    name: "get_contact_details",
    description: "Get complete contact information including all standard fields (email, phone, mobile, company, title, address, etc.) and custom properties (ExtendedProperties/customFields). Use this after finding a contact with search_contacts to answer questions about any field.",
    schema: z.object({
      personName: z.string().describe("Name or ID of the contact to fetch. Use the exact name from search results.")
    })
  }
);

/**
 * Search for BSA users (team members) by name
 * Returns array of matching users
 */
const searchUsersTool = tool(
  async ({ query }, config) => {
    console.log(`[TOOL:SEARCH_USERS] Searching for: "${query}"`);

    try {
      const context = config.context;
      if (!context) {
        throw new Error("Context is required for tool execution");
      }

      const peopleService = getPeopleService();
      const results = await peopleService.resolveUsers([query], context);

      console.log(`[TOOL:SEARCH_USERS] Found ${results.length} users`);

      const simplified = results.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        title: u.title,
        department: u.department
      }));

      return JSON.stringify(simplified, null, 2);
    } catch (error) {
      if (error instanceof NeedsClarification || error instanceof PersonNotFound) {
        throw error;
      }

      console.error("[TOOL:SEARCH_USERS] Error:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
  {
    name: "search_users",
    description: "Search for BSA users (team members in your organization) by name. Returns array of matching users with basic info. Use get_user_details for complete information.",
    schema: z.object({
      query: z.string().describe("Name to search for")
    })
  }
);

/**
 * Get full user (team member) details
 */
const getUserDetailsTool = tool(
  async ({ personName }, config) => {
    console.log(`[TOOL:GET_USER] Fetching details for: "${personName}"`);

    try {
      const context = config.context;
      if (!context) {
        throw new Error("Context is required for tool execution");
      }

      const peopleService = getPeopleService();
      const user = await peopleService.getDetails(personName, 'user', context);

      console.log(`[TOOL:GET_USER] Retrieved user: ${user.name}`);

      return JSON.stringify(user, null, 2);
    } catch (error) {
      if (error instanceof NeedsClarification || error instanceof PersonNotFound) {
        throw error;
      }

      console.error("[TOOL:GET_USER] Error:", error.message);
      return JSON.stringify({ error: error.message });
    }
  },
  {
    name: "get_user_details",
    description: "Get complete user (team member) information including email, phone, title, department, role, etc. Use this after finding a user with search_users.",
    schema: z.object({
      personName: z.string().describe("Name or ID of the user to fetch. Use the exact name from search results.")
    })
  }
);

/**
 * Get all available contact tools
 * These tools are exported as an array for easy binding to LLM
 */
function getContactTools() {
  return [
    searchContactsTool,
    getContactDetailsTool,
    searchUsersTool,
    getUserDetailsTool
  ];
}

module.exports = {
  searchContactsTool,
  getContactDetailsTool,
  searchUsersTool,
  getUserDetailsTool,
  getContactTools
};
