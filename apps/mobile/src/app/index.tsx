import { StyleSheet, Text, View } from 'react-native';

export default function Home() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>OrderLoop</Text>
      <Text style={styles.tagline}>One loop. Every order.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  title: { fontSize: 32, fontWeight: '600' },
  tagline: { fontSize: 16, color: '#666' },
});
