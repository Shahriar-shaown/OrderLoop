import { Tabs } from 'expo-router';
import { MobileHeader } from '@/chrome/MobileHeader';
import { TabBar } from '@/chrome/TabBar';

/** The four tab screens (Home, Orders, Shipments, More); the "+" in the bar is an action, not a screen. */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ header: () => <MobileHeader />, headerShown: true }}
    >
      <Tabs.Screen name="dashboard" />
      <Tabs.Screen name="orders" />
      <Tabs.Screen name="couriers" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}
