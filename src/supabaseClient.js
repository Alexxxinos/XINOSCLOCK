import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://gswglydpojjhxczcfzps.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdzd2dseWRwb2pqaHhjemNmenBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNzk3MTksImV4cCI6MjA5Njg1NTcxOX0.xa0vtDBpsfxBtOBsUKnL2vrvj7MNbK7IWUCxkxD2OAk";

export const supabase = createClient(supabaseUrl, supabaseKey);
