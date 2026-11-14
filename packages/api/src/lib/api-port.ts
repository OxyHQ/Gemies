/**
 * The port this API listens on. ECS injects `PORT` explicitly (oxy-infra
 * terraform-uswest2/app-services-realtime.tf sets it to 3001); 4150 is the
 * local default, the main API's slot in Alia's 4150-4159 block of the per-app
 * port map, so several Oxy backends can run side by side on one machine.
 */
export const API_PORT = Number.parseInt(process.env.PORT || '4150', 10);
