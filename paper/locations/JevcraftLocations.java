package jevcraft.locations;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Answers a player's own location query. Only the server can resolve a missing
 * or obstructed respawn bed in a dimension the client cannot currently see. */
public final class JevcraftLocations extends JavaPlugin implements Listener {
    private static final String CHANNEL = "jevcraft:locations";
    private final Map<UUID, Long> lastRequest = new HashMap<>();

    @Override public void onEnable() {
        Bukkit.getMessenger().registerOutgoingPluginChannel(this, CHANNEL);
        Bukkit.getMessenger().registerIncomingPluginChannel(this, CHANNEL, (channel, player, data) -> {
            if (data.length != 1 || data[0] != 1) return;
            long now = System.currentTimeMillis();
            if (now - lastRequest.getOrDefault(player.getUniqueId(), 0L) < 200) return;
            lastRequest.put(player.getUniqueId(), now);
            send(player, null);
        });
        Bukkit.getPluginManager().registerEvents(this, this);
    }

    @EventHandler public void quit(PlayerQuitEvent event) { lastRequest.remove(event.getPlayer().getUniqueId()); }

    @EventHandler(priority = EventPriority.MONITOR) public void respawn(PlayerRespawnEvent event) {
        Player player = event.getPlayer();
        if (!lastRequest.containsKey(player.getUniqueId())) return;
        Location landing = event.getRespawnLocation().clone();
        Bukkit.getScheduler().runTask(this, () -> { if (player.isOnline()) send(player, landing); });
    }

    // Pathfinding can place two scaffolds before the client sees their
    // acknowledgements. Attribute only successful placements by this player.
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true) public void placed(BlockPlaceEvent event) {
        Player player = event.getPlayer();
        Material type = event.getBlockPlaced().getType();
        if (!event.canBuild() || !lastRequest.containsKey(player.getUniqueId()) ||
                (type != Material.DIRT && type != Material.COBBLESTONE)) return;
        JsonObject placed = point(event.getBlockPlaced().getLocation());
        placed.addProperty("material", type.getKey().getKey());
        JsonObject data = new JsonObject();
        data.addProperty("version", 1);
        data.add("scaffold", placed);
        player.sendPluginMessage(this, CHANNEL, data.toString().getBytes(StandardCharsets.UTF_8));
    }

    private JsonObject point(Location at) {
        JsonObject value = new JsonObject();
        value.addProperty("dimension", at.getWorld().getKey().toString());
        value.addProperty("x", at.getBlockX()); value.addProperty("y", at.getBlockY()); value.addProperty("z", at.getBlockZ());
        return value;
    }

    private void send(Player player, Location lastLanding) {
        World overworld = Bukkit.getWorlds().getFirst();
        Location worldSpawn = overworld.getSpawnLocation();
        Location personal = player.getRespawnLocation();
        JsonObject data = new JsonObject();
        data.addProperty("version", 1);
        data.add("worldSpawn", point(worldSpawn));
        if (personal != null) data.add("personal", point(personal));
        String rule = personal == null ? "world" : "personal";
        Location effective = personal == null ? worldSpawn : personal;
        Plugin rules = Bukkit.getPluginManager().getPlugin("EssentialsSpawn");
        Plugin essentials = Bukkit.getPluginManager().getPlugin("Essentials");
        if (rules != null && rules.isEnabled() && essentials != null && essentials.isEnabled()) {
            try {
                // EssentialsSpawn can override the vanilla bed with a group spawn.
                // Query its actual settings and resolved group, without running
                // a simulated death event or changing the player's spawn.
                Object settings = essentials.getClass().getMethod("getSettings").invoke(essentials);
                if (settings.getClass().getMethod("getRespawnPriority").invoke(settings) != null) {
                    Object user = essentials.getClass().getMethod("getUser", UUID.class).invoke(essentials, player.getUniqueId());
                    boolean homes = (boolean) settings.getClass().getMethod("getRespawnAtHome").invoke(settings);
                    String random = (String) settings.getClass().getMethod("getRandomRespawnLocation").invoke(settings);
                    boolean jailed = (boolean) user.getClass().getMethod("isJailed").invoke(user);
                    if (jailed || (random != null && !random.isBlank() && !random.equalsIgnoreCase("none"))) {
                        rule = "server"; effective = null;
                    } else if (!homes) {
                        String group = (String) user.getClass().getMethod("getGroup").invoke(user);
                        Location groupSpawn = (Location) rules.getClass().getMethod("getSpawn", String.class).invoke(rules, group);
                        if (groupSpawn != null) { rule = "server_spawn"; effective = groupSpawn; }
                    } else {
                        // A server home/anchor policy may also override the bed.
                        // Keep the verified vanilla point and report the actual
                        // landing on the event when that policy is in control.
                        rule = "server"; effective = null;
                    }
                }
            } catch (ReflectiveOperationException | RuntimeException e) {
                rule = "server"; effective = null;
            }
        }
        data.addProperty("rule", rule);
        if (effective != null) data.add("effective", point(effective));
        if (lastLanding != null) data.add("landing", point(lastLanding));
        player.sendPluginMessage(this, CHANNEL, data.toString().getBytes(StandardCharsets.UTF_8));
    }
}
