// Studios, rooms and beat prices. The server uses this to work out the price,
// so a client can't change it in their browser.
// If you change a rate here, change the same rate in ../../index.html (the CATALOG block).
// rate: null means the room has no set hourly rate yet; David sets the price when he approves.

export const STUDIOS = {
  "studio-lyfe": {
    name: "Studio Lyfe",
    address: "10738 Riverside Dr, North Hollywood, CA 91602",
    rooms: {
      A: { name: "Lotus", rate: 85 },
      B: { name: "Sunset", rate: 75 },
      C: { name: "The Alley", rate: 65 },
    },
    budget: true,
  },
  weddington: {
    name: "Weddington Studios",
    address: "11222 Weddington St, North Hollywood, CA 91601",
    rooms: {
      A: { name: "The Phantom", rate: 85 },
      B: { name: "The Weddington", rate: 75 },
      C: { name: "The Brick", rate: null },
      D: { name: "The Vault", rate: null },
    },
    budget: true,
  },
  "boss-gang": {
    name: "Boss Gang Studio",
    address: "4878 Lankershim Blvd, North Hollywood, CA 91601",
    rooms: {
      A: { name: "Room A", rate: 65 },
    },
    budget: false,
  },
};

export const BEATS = {
  lease: { name: "Beat lease", price: 60 },
  week: { name: "Custom beat, one-week turnaround", price: 125 },
  sameday: { name: "Custom beat, same-day turnaround", price: 200 },
};

export const SERVICES = {
  recording: "Recording",
  mixing: "Mixing",
  "recording-mixing": "Recording and mixing",
};

export const MAX_HOURS = 12;

export function roomLabel(studioId, roomId) {
  if (roomId === "budget") return "Special budget (custom quote)";
  const room = STUDIOS[studioId].rooms[roomId];
  const named = room.name === `Room ${roomId}` ? room.name : `Room ${roomId}, ${room.name}`;
  return room.rate == null ? `${named} (rate quoted on approval)` : `${named}, $${room.rate}/hr`;
}
