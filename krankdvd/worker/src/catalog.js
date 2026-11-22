// Studios, rooms and beat prices. The server uses this to work out the price,
// so a client can't change it in their browser.
// If you change a rate here, change the same rate in ../../index.html (the CATALOG block).

export const STUDIOS = {
  "studio-lyfe": {
    name: "Studio Lyfe",
    address: "10738 Riverside Dr, North Hollywood, CA 91602",
    rooms: { A: 85, B: 75, C: 65 },
  },
  "the-watche": {
    name: "The Watche Studio Weddington",
    address: "11222 Weddington St, North Hollywood, CA 91601",
    rooms: { A: 85, B: 75 },
  },
  "boss-gang": {
    name: "Boss Gang Studio",
    address: "4878 Lankershim Blvd, North Hollywood, CA 91601",
    rooms: { A: 65 },
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
