import React from 'react';
import { TouchableOpacity } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';

import JiraScreen from '../screens/JiraScreen';
import SlackScreen from '../screens/SlackScreen';
import RemindersScreen from '../screens/RemindersScreen';
import TasksScreen from '../screens/TasksScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function TabNavigator() {
  const { jiraIssues, slackMessages, reminders, scheduledTasks } = useApp();
  const { colors, isDark, toggleTheme } = useTheme();

  const urgentSlack = slackMessages.filter(m => m.importance >= 3).length;
  const overdueCount = scheduledTasks.filter(
    t => !t.done && new Date(t.startTime) < new Date()
  ).length;

  const ThemeToggle = () => (
    <TouchableOpacity
      onPress={toggleTheme}
      style={{ marginRight: 14, padding: 4 }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons
        name={isDark ? 'sunny-outline' : 'moon-outline'}
        size={20}
        color={colors.subtext}
      />
    </TouchableOpacity>
  );

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          const icons = {
            Jira:     focused ? 'bug'          : 'bug-outline',
            Slack:    focused ? 'chatbubbles'  : 'chatbubbles-outline',
            Reminders:focused ? 'bookmark'     : 'bookmark-outline',
            Tasks:    focused ? 'calendar'     : 'calendar-outline',
            Settings: focused ? 'settings'     : 'settings-outline',
          };
          return <Ionicons name={icons[route.name]} size={size} color={color} />;
        },
        tabBarActiveTintColor:   colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor:  colors.border,
          borderTopWidth: 1,
          height: 60,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700', fontSize: 17 },
        headerShadowVisible: false,
        headerRight: () => <ThemeToggle />,
      })}
    >
      <Tab.Screen
        name="Jira"
        component={JiraScreen}
        options={{
          tabBarBadge: jiraIssues.length > 0 ? jiraIssues.length : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, fontSize: 10 },
        }}
      />
      <Tab.Screen
        name="Slack"
        component={SlackScreen}
        options={{
          tabBarBadge: urgentSlack > 0 ? urgentSlack : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.warning, fontSize: 10 },
        }}
      />
      <Tab.Screen
        name="Reminders"
        component={RemindersScreen}
        options={{
          tabBarBadge: reminders.length > 0 ? reminders.length : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent, fontSize: 10 },
        }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksScreen}
        options={{
          tabBarBadge: overdueCount > 0 ? overdueCount : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.warning, fontSize: 10 },
        }}
      />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
