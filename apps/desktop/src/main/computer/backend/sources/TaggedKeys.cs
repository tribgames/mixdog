public interface IMixKeySink {
  void Down(ushort key);
  void Up(ushort key);
  void Tap(ushort key);
  void Text(string text);
}

// Parse the complete stream before emitting any input. Every key uses the
// same tagged transport, including grouped modifiers and escaped literals.
public static class MixTaggedKeys {
  sealed class NativeSink : IMixKeySink {
    public void Down(ushort key) { MixWin32.KeyDown(key); }
    public void Up(ushort key) { MixWin32.KeyUp(key); }
    public void Tap(ushort key) { MixWin32.KeyTap(key); }
    public void Text(string text) { MixWin32.SendText(text); }
  }
  sealed class Node {
    public System.Collections.Generic.List<ushort> Modifiers = new System.Collections.Generic.List<ushort>();
    public System.Collections.Generic.List<Node> Children;
    public ushort? Key;
    public string Text;
    public int Repeat = 1;
  }
  sealed class Parser {
    readonly string source;
    int at;
    int cost;
    public Parser(string value) {
      source = value ?? "";
      if (source.Length > 512) Invalid();
    }
    static void Invalid() { throw new System.Exception("invalid_keys: malformed or excessive key stream"); }
    public System.Collections.Generic.List<Node> Parse(int depth, bool group) {
      if (depth > 8) Invalid();
      var nodes = new System.Collections.Generic.List<Node>();
      while (at < source.Length) {
        if (source[at] == ')') {
          if (!group) Invalid();
          at++; return nodes;
        }
        var node = new Node();
        while (at < source.Length && "^%+".IndexOf(source[at]) >= 0) {
          ushort modifier = (ushort)(source[at] == '^' ? 0x11 : source[at] == '%' ? 0x12 : 0x10);
          if (node.Modifiers.Contains(modifier)) Invalid();
          node.Modifiers.Add(modifier); at++;
        }
        if (at >= source.Length) Invalid();
        char token = source[at++];
        if (token == '(') node.Children = Parse(depth + 1, true);
        else if (token == '{') {
          if (at + 1 < source.Length && (source[at] == '{' || source[at] == '}') && source[at + 1] == '}') {
            node.Text = source[at++].ToString(); at++;
          } else {
            int end = source.IndexOf('}', at);
            if (end < 0) Invalid();
            string text = source.Substring(at, end - at);
            at = end + 1;
            int space = text.LastIndexOf(' ');
            if (space >= 0) {
              int repeat;
              if (!int.TryParse(text.Substring(space + 1), out repeat) || repeat < 1 || repeat > 100) Invalid();
              node.Repeat = repeat; text = text.Substring(0, space);
            }
            if (text.Length == 1 && "+^%~()[]".IndexOf(text[0]) >= 0) node.Text = text;
            else node.Key = (ushort)MixWin32.NamedVirtualKey(text.ToUpperInvariant());
          }
        } else if (token == '~') node.Key = 0x0D;
        else if (token == ')' || token == '}' || char.IsControl(token)) { Invalid(); }
        else node.Text = token.ToString();
        cost += node.Repeat;
        if (cost > 10000) Invalid();
        nodes.Add(node);
      }
      if (group) Invalid();
      return nodes;
    }
  }
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  static extern short VkKeyScan(char value);
  static void Validate(System.Collections.Generic.List<Node> nodes, System.Collections.Generic.HashSet<ushort> inherited) {
    foreach (var node in nodes) {
      var modifiers = new System.Collections.Generic.HashSet<ushort>(inherited);
      foreach (var modifier in node.Modifiers) modifiers.Add(modifier);
      if (node.Key == 0x73 && modifiers.Contains(0x12)) {
        throw new System.Exception("unsafe_key: Alt+F4 is blocked");
      }
      if (node.Children != null) Validate(node.Children, modifiers);
      else if (node.Text != null && modifiers.Count > 0) {
        short mapping = VkKeyScan(node.Text[0]);
        if (mapping == -1) throw new System.Exception("invalid_keys: character has no modified-key mapping");
        node.Key = (ushort)(mapping & 255); node.Text = null;
        if ((mapping & 0x100) != 0 && !modifiers.Contains(0x10)) node.Modifiers.Add(0x10);
        if ((mapping & 0x200) != 0 && !modifiers.Contains(0x11)) node.Modifiers.Add(0x11);
        if ((mapping & 0x400) != 0 && !modifiers.Contains(0x12)) node.Modifiers.Add(0x12);
      }
    }
  }
  static void Execute(System.Collections.Generic.List<Node> nodes, IMixKeySink sink, System.Collections.Generic.HashSet<ushort> held) {
    foreach (var node in nodes) {
      var pressed = new System.Collections.Generic.List<ushort>();
      try {
        foreach (var modifier in node.Modifiers) {
          if (held.Contains(modifier)) continue;
          // Track before dispatch: partial transport failure still needs release.
          pressed.Add(modifier); held.Add(modifier); sink.Down(modifier);
        }
        if (node.Children != null) Execute(node.Children, sink, held);
        else for (int count = 0; count < node.Repeat; count++) {
          if (node.Key.HasValue) sink.Tap(node.Key.Value);
          else sink.Text(node.Text);
        }
      } finally {
        System.Exception releaseError = null;
        for (int index = pressed.Count - 1; index >= 0; index--) {
          try { sink.Up(pressed[index]); }
          catch (System.Exception error) { if (releaseError == null) releaseError = error; }
          finally { held.Remove(pressed[index]); }
        }
        if (releaseError != null) throw new System.Exception("input_cleanup_unconfirmed: key release failed", releaseError);
      }
    }
  }
  public static void Send(string value) { Send(value, new NativeSink()); }
  public static void Send(string value, IMixKeySink sink) {
    var nodes = new Parser(value).Parse(0, false);
    Validate(nodes, new System.Collections.Generic.HashSet<ushort>());
    Execute(nodes, sink, new System.Collections.Generic.HashSet<ushort>());
  }
}
