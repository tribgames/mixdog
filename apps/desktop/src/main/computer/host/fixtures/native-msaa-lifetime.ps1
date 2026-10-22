[Console]::Error.WriteLine('probe:compile-msaa-lifetime-fixture')
Add-Type -ReferencedAssemblies @(
    'System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', $AccessibilityAssemblyPath
) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.CompilerServices;
using System.Windows.Forms;

public sealed class MixdogMsaaLifetimeControl : Control {
  readonly List<WeakReference> visitedLeaves = new List<WeakReference>();
  public int VisitedLeaves { get { return visitedLeaves.Count; } }
  public int LaterBranchChecks { get; private set; }
  public bool KeptDuringTraversal { get; private set; }
  public int Invocations { get; private set; }

  public MixdogMsaaLifetimeControl() { KeptDuringTraversal = true; }
  protected override AccessibleObject CreateAccessibilityInstance() { return new Root(this); }

  [MethodImpl(MethodImplOptions.NoInlining)]
  static void CollectGarbage() {
    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();
  }

  void CheckEarlierLeaf() {
    if (visitedLeaves.Count == 0) return;
    CollectGarbage();
    LaterBranchChecks++;
    foreach (WeakReference leaf in visitedLeaves) KeptDuringTraversal &= leaf.IsAlive;
  }

  public bool CollectedAfterSnapshot() {
    CollectGarbage();
    foreach (WeakReference leaf in visitedLeaves) if (leaf.IsAlive) return false;
    return true;
  }

  sealed class Root : ControlAccessibleObject {
    readonly MixdogMsaaLifetimeControl owner;
    public Root(MixdogMsaaLifetimeControl owner) : base(owner) { this.owner = owner; }
    public override int GetChildCount() { return 2; }
    public override AccessibleObject GetChild(int index) {
      if (index == 0) return new Branch(owner, false);
      if (index == 1) return new Branch(owner, true);
      return null;
    }
  }

  abstract class NamedNode : AccessibleObject {
    readonly string name;
    readonly AccessibleRole role;
    protected NamedNode(string name, AccessibleRole role) { this.name = name; this.role = role; }
    public override string Name { get { return name; } }
    public override AccessibleRole Role { get { return role; } }
    public override AccessibleStates State { get { return AccessibleStates.None; } }
    public override Rectangle Bounds { get { return new Rectangle(10, 10, 20, 20); } }
    public override int GetChildCount() { return 0; }
  }

  sealed class Branch : NamedNode {
    readonly MixdogMsaaLifetimeControl owner;
    readonly bool later;
    public Branch(MixdogMsaaLifetimeControl owner, bool later)
      : base(later ? "later branch" : "earlier branch", AccessibleRole.Grouping) {
      this.owner = owner; this.later = later;
    }
    public override int GetChildCount() {
      if (later) owner.CheckEarlierLeaf();
      return 1;
    }
    public override AccessibleObject GetChild(int index) {
      if (index == 0) return later ? (AccessibleObject)new Button(owner) : new OmittedLeaf(owner);
      return null;
    }
  }

  sealed class OmittedLeaf : NamedNode {
    readonly MixdogMsaaLifetimeControl owner;
    bool observed;
    public OmittedLeaf(MixdogMsaaLifetimeControl owner) : base("omitted leaf", AccessibleRole.ScrollBar) {
      this.owner = owner;
    }
    public override Rectangle Bounds {
      get {
        if (!observed) {
          owner.visitedLeaves.Add(new WeakReference(this));
          observed = true;
        }
        return Rectangle.Empty;
      }
    }
  }

  sealed class Button : NamedNode {
    readonly MixdogMsaaLifetimeControl owner;
    public Button(MixdogMsaaLifetimeControl owner) : base("live button", AccessibleRole.PushButton) {
      this.owner = owner;
    }
    public override string DefaultAction { get { return "Press"; } }
    public override void DoDefaultAction() { owner.Invocations++; }
  }
}
'@

$control = New-Object MixdogMsaaLifetimeControl
$control.Location = New-Object System.Drawing.Point(-30000, -30000)
$control.Size = New-Object System.Drawing.Size(320, 240)
try {
    $handle = $control.Handle
    $snapshot = [MixMsaa]::SnapshotWithStatus($handle, [MixWin32]::WindowId($handle), 100)
    $button = @($snapshot.Nodes | Where-Object { $_.Name -eq 'live button' })
    if ($button.Count -eq 1) { $button[0].DoDefaultAction() }
    $payload = @{
        visitedLeaves = $control.VisitedLeaves
        laterBranchChecks = $control.LaterBranchChecks
        keptDuringTraversal = $control.KeptDuringTraversal
        names = @($snapshot.Nodes | ForEach-Object { $_.Name })
        invocations = $control.Invocations
        collectedAfterSnapshot = $control.CollectedAfterSnapshot()
    }
}
finally {
    $control.Dispose()
}
[Console]::Out.WriteLine('@@MIXCU@@' + ($payload | ConvertTo-Json -Compress -Depth 5))
exit
