/**
 * Deterministic hotel-assistant prompt library.
 *
 * Prepared prompts are intentionally answered from MongoDB by services/agent.js.
 * Gemini is NOT required for these prompts. Free-form questions can still fall
 * through to Gemini when their wording is ambiguous.
 */

const ALL = ["receptionist", "cleaner", "manager", "facility", "owner"];
const MANAGERS = ["manager", "owner"];
const FRONTDESK = ["receptionist", "manager", "owner"];
const HOUSEKEEPING = ["cleaner", "receptionist", "manager", "owner"];
const FACILITY = ["facility", "receptionist", "manager", "owner"];

const PREPARED_PROMPTS = [
  // Daily running
  { id:"today_briefing", label:"What needs my attention today?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"operationsSnapshot", instruction:"Give today's actionable front-desk briefing." },
  { id:"rooms_not_ready", label:"Which rooms aren't ready to sell?", group:"Daily running", roles:HOUSEKEEPING, scope:"location", context:"housekeepingSnapshot", instruction:"List rooms that cannot currently be sold and their status." },
  { id:"arrivals_today", label:"Who is arriving today?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"arrivalsToday", instruction:"List today's arrivals with guest, room, room type, stay length and booking reference." },
  { id:"departures_today", label:"Who is checking out today?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"departuresToday", instruction:"List today's departures, room and outstanding balance where available." },
  { id:"in_house_guests", label:"Who is currently staying here?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"inHouseGuests", instruction:"List current in-house guests by room and booking reference." },
  { id:"occupancy_today", label:"How full are we today?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"todayOccupancy", instruction:"Give current occupied rooms, sellable rooms and occupancy percentage." },
  { id:"pending_requests", label:"What website requests are waiting?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"pendingRequests", instruction:"List pending website requests and whether the requested room type has availability." },
  { id:"occupancy_outlook", label:"How full are the next two weeks?", group:"Daily running", roles:MANAGERS, scope:"location", context:"forwardOccupancy", instruction:"Show the next 14 nights with occupancy percentages and flag the fullest and emptiest nights." },
  { id:"urgent_notifications", label:"What alerts need attention?", group:"Daily running", roles:ALL, scope:"location", context:"notifications", instruction:"Show the newest urgent/relevant alerts." },
  { id:"unread_notifications", label:"How many alerts are unread?", group:"Daily running", roles:ALL, scope:"location", context:"notifications", instruction:"Count unread notifications for the current user and show the latest ones." },
  { id:"no_shows", label:"Who are the no-shows?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"bookingStatusesToday", instruction:"List bookings marked no-show." },
  { id:"cancellations", label:"What bookings were cancelled?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"bookingStatusesToday", instruction:"List recent cancelled bookings." },

  // Money
  { id:"unpaid_balances", label:"Who still owes money?", group:"Money", roles:FRONTDESK, scope:"location", context:"outstandingBalances", instruction:"List current outstanding guest balances, largest first." },
  { id:"revenue_review", label:"How did the last 30 days go?", group:"Money", roles:MANAGERS, scope:"location", context:"revenueSummary", instruction:"Summarise occupancy, ADR, RevPAR, room revenue, facility revenue and total revenue." },
  { id:"compare_properties", label:"How do the two properties compare?", group:"Money", roles:MANAGERS, scope:"both", context:"propertyComparison", instruction:"Compare the two properties on occupancy, ADR and revenue." },
  { id:"pricing_check", label:"Are my rates right?", group:"Money", roles:MANAGERS, scope:"location", context:"pricingSignals", instruction:"Compare current room rates with recent occupancy signals and give a cautious direction." },
  { id:"sales_today", label:"How much did we make today?", group:"Money", roles:MANAGERS, scope:"location", context:"todaySales", instruction:"Give today's room sales, facility sales, total sales and payment count." },
  { id:"payment_methods", label:"How were we paid today?", group:"Money", roles:MANAGERS, scope:"location", context:"todaySales", instruction:"Break today's payments down by method." },
  { id:"facility_revenue", label:"How much did each facility make?", group:"Money", roles:MANAGERS, scope:"location", context:"facilityRevenue", instruction:"Break facility takings down by facility and settlement type." },
  { id:"recent_payments", label:"What payments came in recently?", group:"Money", roles:FRONTDESK, scope:"location", context:"recentPayments", instruction:"Show recent verified/recorded payments with amount, method and reference." },
  { id:"payment_fees", label:"How much are payment fees costing us?", group:"Money", roles:MANAGERS, scope:"location", context:"paymentFees", instruction:"Show card/payment-gateway fees for the selected period." },

  // Guests
  { id:"booking_sources", label:"Where are bookings coming from?", group:"Guests", roles:MANAGERS, scope:"location", context:"bookingSources", instruction:"Break down bookings by source." },
  { id:"repeat_guests", label:"Who are my regulars?", group:"Guests", roles:FRONTDESK, scope:"both", context:"repeatGuests", instruction:"List repeat guests by stays, nights and spend." },
  { id:"guest_count", label:"How many guests do we have?", group:"Guests", roles:FRONTDESK, scope:"location", context:"guestStats", instruction:"Give total guest records and current in-house guest count." },
  { id:"blacklisted_guests", label:"Are any guests blacklisted?", group:"Guests", roles:FRONTDESK, scope:"location", context:"guestStats", instruction:"List blacklisted guest names." },

  // Rooms and rates
  { id:"room_inventory", label:"How many rooms do we have?", group:"Rooms", roles:HOUSEKEEPING, scope:"location", context:"roomInventory", instruction:"Give total rooms by room type and status." },
  { id:"available_rooms_now", label:"Which rooms are available now?", group:"Rooms", roles:FRONTDESK, scope:"location", context:"availableRoomsNow", instruction:"List currently sellable rooms." },
  { id:"room_status_counts", label:"What is the room status breakdown?", group:"Rooms", roles:HOUSEKEEPING, scope:"location", context:"roomInventory", instruction:"Show counts of available, occupied, dirty, cleaning and maintenance rooms." },
  { id:"dirty_rooms", label:"Which rooms are dirty?", group:"Rooms", roles:HOUSEKEEPING, scope:"location", context:"roomStatusDetail:dirty", instruction:"List rooms currently marked dirty." },
  { id:"cleaning_rooms", label:"Which rooms are being cleaned?", group:"Rooms", roles:HOUSEKEEPING, scope:"location", context:"roomStatusDetail:cleaning", instruction:"List rooms currently being cleaned." },
  { id:"maintenance_rooms", label:"Which rooms are under maintenance?", group:"Rooms", roles:HOUSEKEEPING, scope:"location", context:"roomStatusDetail:maintenance", instruction:"List rooms currently under maintenance." },
  { id:"occupied_rooms", label:"Which rooms are occupied?", group:"Rooms", roles:HOUSEKEEPING, scope:"location", context:"roomStatusDetail:occupied", instruction:"List occupied rooms." },
  { id:"current_rates", label:"What are our current room rates?", group:"Rooms", roles:FRONTDESK, scope:"location", context:"currentRates", instruction:"Show current nightly rates by room type." },
  { id:"availability_by_type", label:"What room types are available for a stay?", group:"Rooms", roles:FRONTDESK, scope:"location", context:"none", instruction:"Use dates from the user's question to return available room counts by type." },
  { id:"upcoming_bookings", label:"What bookings are coming up?", group:"Daily running", roles:FRONTDESK, scope:"location", context:"upcomingBookings", instruction:"List confirmed and in-house bookings starting in the next 7 days." },

  // Facilities
  { id:"facility_status", label:"Which facilities are open?", group:"Facilities", roles:FACILITY, scope:"location", context:"facilityStatus", instruction:"List facilities, current status, hours and status notes." },
  { id:"facility_sales_today", label:"How much did the facilities sell today?", group:"Facilities", roles:FACILITY, scope:"location", context:"facilityRevenueToday", instruction:"Show today's facility sales by facility." },
  { id:"facility_charges_today", label:"What charges were posted at a facility today?", group:"Facilities", roles:FACILITY, scope:"location", context:"facilityRevenueToday", instruction:"Show today's facility charge counts and totals." },

  // Website / requests / content
  { id:"request_summary", label:"What is the status of website requests?", group:"Website", roles:FRONTDESK, scope:"location", context:"requestSummary", instruction:"Count pending, accepted, declined and expired booking requests." },
  { id:"published_content", label:"What is currently published on the website?", group:"Website", roles:MANAGERS, scope:"location", context:"publishedContent", instruction:"List live website banners, popups, announcements and sections." },
  { id:"faq_knowledge", label:"What information can the hotel FAQ answer?", group:"Website", roles:MANAGERS, scope:"location", context:"faqKnowledge", instruction:"List active FAQ categories and sample questions." },

  // Staff / audit
  { id:"staff_overview", label:"Who is on the staff?", group:"Staff", roles:MANAGERS, scope:"both", context:"staffOverview", instruction:"List staff names, roles, property and active state; never show passwords." },
  { id:"staff_by_role", label:"How many staff do we have by role?", group:"Staff", roles:MANAGERS, scope:"both", context:"staffOverview", instruction:"Count active and inactive staff by role and property." },
  { id:"audit_recent", label:"What changed recently?", group:"Audit", roles:MANAGERS, scope:"both", context:"recentAudit", instruction:"Show recent audit actions with time, staff member and action." },

  // Learning / help
  { id:"explain_metric", label:"Explain a hotel term", group:"Learning", roles:ALL, scope:"none", context:"none", instruction:"Explain a hotel term in plain English from the local term dictionary." },
  { id:"command_help", label:"How can I ask the assistant?", group:"Commands", roles:ALL, scope:"none", context:"none", instruction:"Show deterministic commands and examples." },
];

const promptById = (id) => PREPARED_PROMPTS.find((p) => p.id === id);
const promptsForRole = (role) => PREPARED_PROMPTS.filter(p => p.roles.includes(role)).map(({id,label,group,scope}) => ({id,label,group,scope}));

module.exports = { PREPARED_PROMPTS, promptById, promptsForRole };
