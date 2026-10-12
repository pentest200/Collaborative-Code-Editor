const paths = {
 files: "M8 3h10l3 3v14H8z M8 3v3H3v15h3 M17 3v5h4",
 file: "M5 2h9l5 5v15H5z M14 2v6h5",
 folder: "M3 5h7l2 3h9v12H3z",
 search: "M21 21l-6-6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
 terminal: "M3 4h18v16H3z M6 8l4 4-4 4 M13 16h5",
 settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
 play: "M7 4l14 8-14 8z",
 stop: "M5 5h14v14H5z",
 plus: "M12 4v16 M4 12h16",
 upload: "M12 16V3 M7 8l5-5 5 5 M4 14v7h16v-7",
 download: "M12 3v13 M7 11l5 5 5-5 M4 17v4h16v-4",
 close: "M6 6l12 12 M18 6L6 18",
 down: "M6 9l6 6 6-6",
 right: "M9 6l6 6-6 6",
 history: "M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2",
 people: "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 8 M18 15a4 4 0 0 1 4 4v2",
 check: "M4 12l5 5L20 6",
 code: "M8 5L2 12l6 7 M16 5l6 7-6 7 M14 3l-4 18",
 edit: "M15 4l5 5 M4 16L16 4a2 2 0 0 1 4 4L8 20l-5 1z",
 move: "M12 3v18 M3 12h18 M8 7l4-4 4 4 M8 17l4 4 4-4 M7 8l-4 4 4 4 M17 8l4 4-4 4",
 trash: "M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
 layout: "M3 3h18v18H3z M3 8h18 M8 8v13",
 expand: "M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6",
 refresh: "M20 7a9 9 0 1 0 1 9 M20 2v6h-6",
 book: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3z M12 6v16",
} as const;

export default function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
