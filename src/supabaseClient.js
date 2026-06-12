import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://gswglydpojjhxczcfzps.supabase.co";
const supabaseKey = "sb_publishable_FW4ueA4KVWAZYKPXqIVWHw_mUS-HJww";

export const supabase = createClient(supabaseUrl, supabaseKey);
